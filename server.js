require("dotenv").config();
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const Stripe = require("stripe");
const Database = require("better-sqlite3");
const { Resend } = require("resend");
const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, Packer, BorderStyle } = require("docx");
const path = require("path");

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Resend email client (optional)
const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;
const FROM_EMAIL = process.env.FROM_EMAIL || "onboarding@resend.dev";

// ─── SQLite setup ────────────────────────────────────────────────────────────
const db = new Database(path.join(__dirname, "jobs.db"));

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    resume TEXT NOT NULL,
    job_description TEXT NOT NULL,
    email TEXT,
    paid INTEGER NOT NULL DEFAULT 0,
    result TEXT,
    ats_id TEXT,
    created_at INTEGER NOT NULL
  )
`);

// Add ats_id column if it doesn't exist (migration for existing DBs)
try {
  db.exec(`ALTER TABLE jobs ADD COLUMN ats_id TEXT`);
} catch (_) { /* column already exists */ }

// Add after_ats_score column if it doesn't exist (migration for existing DBs)
try {
  db.exec(`ALTER TABLE jobs ADD COLUMN after_ats_score INTEGER`);
} catch (_) { /* column already exists */ }

db.exec(`
  CREATE TABLE IF NOT EXISTS ats_checks (
    id TEXT PRIMARY KEY,
    resume TEXT NOT NULL,
    job_description TEXT NOT NULL,
    score INTEGER NOT NULL,
    missing_keywords TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )
`);

// Prepared statements
const stmtInsert = db.prepare(
  `INSERT INTO jobs (id, resume, job_description, email, paid, result, ats_id, created_at)
   VALUES (@id, @resume, @job_description, @email, @paid, @result, @ats_id, @created_at)`
);
const stmtGet    = db.prepare(`SELECT * FROM jobs WHERE id = ?`);
const stmtUpdate = db.prepare(`UPDATE jobs SET paid = @paid, email = @email WHERE id = @id`);
const stmtResult = db.prepare(`UPDATE jobs SET result = @result, after_ats_score = @after_ats_score WHERE id = @id`);
const stmtDelete = db.prepare(`DELETE FROM jobs WHERE created_at < ?`);

// ATS checks statements
const stmtAtsInsert = db.prepare(
  `INSERT INTO ats_checks (id, resume, job_description, score, missing_keywords, created_at)
   VALUES (@id, @resume, @job_description, @score, @missing_keywords, @created_at)`
);
const stmtAtsGet = db.prepare(`SELECT * FROM ats_checks WHERE id = ?`);
const stmtAtsDelete = db.prepare(`DELETE FROM ats_checks WHERE created_at < ?`);

function cleanOldJobs() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const info = stmtDelete.run(cutoff);
  if (info.changes > 0) console.log(`Cleaned up ${info.changes} expired job(s)`);
  const atsInfo = stmtAtsDelete.run(cutoff);
  if (atsInfo.changes > 0) console.log(`Cleaned up ${atsInfo.changes} expired ATS check(s)`);
}

// Clean on startup + every hour
cleanOldJobs();
setInterval(cleanOldJobs, 60 * 60 * 1000);

// ─── In-memory Set to track which jobs are currently being generated ─────────
const generating = new Set();

// ─── Generate .docx from resume markdown text ────────────────────────────────
async function generateResumeDocx(resumeText) {
  const lines = resumeText.split("\n");
  const children = [];

  let nameFound = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      children.push(new Paragraph({ text: "" }));
      continue;
    }
    // Name — first H1/H2
    if (!nameFound && /^#{1,2}\s+/.test(trimmed)) {
      const name = trimmed.replace(/^#+\s+/, "").replace(/\*\*/g, "");
      children.push(new Paragraph({
        children: [new TextRun({ text: name, bold: true, size: 36, color: "111111" })],
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.LEFT,
        spacing: { after: 120 },
      }));
      nameFound = true;
      continue;
    }
    // Section header — ### or ALL CAPS or **ALL CAPS**
    if (/^###\s+/.test(trimmed) || /^\*\*[A-Z][A-Z\s&]+\*\*$/.test(trimmed) || /^[A-Z][A-Z\s&]{3,}$/.test(trimmed)) {
      const label = trimmed.replace(/^#+\s+/, "").replace(/\*\*/g, "");
      children.push(new Paragraph({
        children: [new TextRun({ text: label, bold: true, size: 22, color: "555555", allCaps: true })],
        spacing: { before: 240, after: 60 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "DDDDDD" } },
      }));
      continue;
    }
    // Bullet
    if (/^[-*•]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed)) {
      const content = trimmed.replace(/^[-*•]\s+/, "").replace(/^\d+\.\s+/, "").replace(/\*\*(.+?)\*\*/g, "$1");
      children.push(new Paragraph({
        children: [new TextRun({ text: content, size: 22 })],
        bullet: { level: 0 },
        spacing: { after: 40 },
      }));
      continue;
    }
    // Regular line
    const content = trimmed.replace(/\*\*(.+?)\*\*/g, "$1");
    children.push(new Paragraph({
      children: [new TextRun({ text: content, size: 22 })],
      spacing: { after: 60 },
    }));
  }

  const doc = new Document({
    sections: [{ properties: {}, children }],
  });

  return await Packer.toBuffer(doc);
}

// ─── Email helper ─────────────────────────────────────────────────────────────
async function sendRoastEmail(toEmail, roastText, docxBuffer) {
  if (!resend) {
    console.warn("RESEND_API_KEY not set — skipping email delivery");
    return;
  }
  try {
    // Convert basic markdown to HTML for the email body
    const htmlBody = roastText
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/^## (.+)$/gm, "<h2 style='color:#ff4d4d;margin:24px 0 8px'>$1</h2>")
      .replace(/^### (.+)$/gm, "<h3 style='color:#ff4d4d;margin:16px 0 6px'>$1</h3>")
      .replace(/^\d+\.\s+(.+)$/gm, "<li>$1</li>")
      .replace(/^[-*]\s+(.+)$/gm, "<li>$1</li>")
      .replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul style='margin:8px 0 16px 24px'>$1</ul>")
      .replace(/^---$/gm, "<hr style='border:none;border-top:1px solid #444;margin:24px 0'>")
      .replace(/\n\n/g, "</p><p style='margin:0 0 12px'>")
      .replace(/\n/g, "<br>")
      .replace(/^/, "<p style='margin:0 0 12px'>")
      .replace(/$/, "</p>")
      .replace(/<p style='margin:0 0 12px'>\s*<\/p>/g, "");

    const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="background:#0f0f0f;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0">
  <div style="max-width:700px;margin:0 auto;padding:40px 24px">
    <h1 style="color:#fff;font-size:2rem;font-weight:800;margin-bottom:8px">
      Your Resume <span style="color:#ff4d4d">Roast</span> is Ready 🔥
    </h1>
    <p style="color:#888;margin:0 0 32px">Here's what our AI career coach thinks. Brace yourself.</p>
    <div style="background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:32px;line-height:1.7;font-size:1rem">
      ${htmlBody}
    </div>
    <p style="color:#444;font-size:0.8rem;margin-top:32px;text-align:center">
      &copy; 2026 ResumeSucks.com &mdash; Powered by AI. No refunds on hurt feelings.
    </p>
  </div>
</body>
</html>`;

    const emailPayload = {
      from: FROM_EMAIL,
      to: toEmail,
      subject: "Your Resume Roast is Ready 🔥",
      html,
    };
    if (docxBuffer) {
      emailPayload.attachments = [{
        filename: "resume-rewritten.docx",
        content: docxBuffer,
      }];
    }
    await resend.emails.send(emailPayload);
    console.log(`Roast email sent to ${toEmail}`);
  } catch (err) {
    console.error("Failed to send roast email:", err.message);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Stripe webhook needs raw body
app.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const job = stmtGet.get(session.id);
      if (job) {
        const email = session.customer_details?.email || null;
        stmtUpdate.run({ paid: 1, email, id: session.id });
        console.log(`Payment confirmed via webhook for session ${session.id}${email ? ` (${email})` : ""}`);
      }
    }

    res.json({ received: true });
  }
);

// Parse JSON for all other routes
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ─── ATS Score computation (no Claude, no API cost) ──────────────────────────

const STOPWORDS = new Set([
  "a","an","the","and","or","but","is","are","was","were","be","been","being",
  "have","has","had","do","does","did","will","would","shall","should","may",
  "might","must","can","could","to","of","in","on","at","by","for","with",
  "about","against","between","into","through","during","before","after",
  "above","below","from","up","down","out","off","over","under","again",
  "further","then","once","here","there","when","where","why","how","all",
  "both","each","few","more","most","other","some","such","no","not","only",
  "own","same","so","than","too","very","just","that","this","these","those",
  "i","we","you","he","she","it","they","me","him","her","us","them","who",
  "which","what","as","if","while","although","because","since","unless",
  "their","our","your","his","its","my","any","well","also","using","work",
  "working","use","used","ensure","help","strong","ability","excellent","great",
  "good","new","high","large","key","years","experience","position","role",
  "join","team","make","within","across","including","support","provide",
  "develop","build","create","manage","lead","drive","define","own","run",
  "get","set","stay","grow","take","bring","put","keep",
  // Common job posting filler words
  "looking","seeking","required","must","need","needs","candidate","candidates",
  "ideal","preferred","plus","minimum","least","one","two","three","four","five",
  "senior","junior","mid","level","based","remote","hybrid","onsite","full","time",
  "part","contract","permanent","opportunity","join","company","team","startup",
  "etc","apply","applicants","applicant","responsible","responsibilities",
  "requirement","requirements","qualifications","qualification","desired",
  "include","includes","including","related","relevant","similar","equivalent",
  "proven","demonstrated","ability","able","comfortable","familiar","knowledge",
  "background","track","record","prior","previous","please","submit","send",
  "equal","employer","opportunity","benefits","compensation","salary","pay",
]);

function computeAtsScore(resume, jobDescription) {
  const resumeLower = resume.toLowerCase();

  // Tokenize job description into words (strip leading/trailing punctuation per token)
  const rawWords = jobDescription.toLowerCase()
    .replace(/[^a-z0-9\s+#./-]/g, " ")
    .split(/\s+/)
    .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")) // trim punctuation
    .filter(w => w.length > 2 && !STOPWORDS.has(w));

  // Count word frequency in JD
  const wordFreq = {};
  for (const w of rawWords) {
    wordFreq[w] = (wordFreq[w] || 0) + 1;
  }

  // Build unigram keywords (appear at least once, not stopwords)
  const unigrams = Object.keys(wordFreq);

  // Known tech/career phrases — always treated as a unit even if mentioned once
  const KNOWN_PHRASES = new Set([
    "system design","distributed systems","machine learning","deep learning",
    "natural language processing","computer vision","data structures","algorithms",
    "ci/cd","ci cd","continuous integration","continuous deployment","continuous delivery",
    "test driven development","agile methodology","scrum master","product roadmap",
    "go to market","product led growth","churn reduction","customer success",
    "demand generation","pipeline attribution","marketing qualified lead","sales qualified lead",
    "a/b testing","unit testing","integration testing","end to end testing",
    "microservices architecture","service oriented","event driven","domain driven",
    "cross functional","stakeholder management","executive communication",
    "p&l responsibility","revenue growth","cost reduction","operational efficiency",
    "full stack","front end","back end","devops","mlops","data pipeline",
    "cloud infrastructure","kubernetes","docker","terraform","infrastructure as code",
    "rest api","graphql","api design","system architecture","technical leadership",
    "engineering manager","product manager","data scientist","data engineer",
    "on call","incident response","site reliability","performance optimization",
    "brand awareness","content strategy","social media","email marketing",
    "search engine optimization","pay per click","conversion rate","customer acquisition",
    "project management","change management","people management","team building",
  ]);

  // Extract 2-gram and 3-gram phrases
  const jdLower = jobDescription.toLowerCase().replace(/[^a-z0-9\s+#./-]/g, " ");
  const jdWords = jdLower.split(/\s+/)
    .map(w => w.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, ""))
    .filter(w => w.length > 0);
  const phraseFreq = {};
  for (let i = 0; i < jdWords.length - 1; i++) {
    const w1 = jdWords[i], w2 = jdWords[i + 1];
    if (!STOPWORDS.has(w1) && !STOPWORDS.has(w2) && w1.length > 2 && w2.length > 2) {
      const phrase = `${w1} ${w2}`;
      phraseFreq[phrase] = (phraseFreq[phrase] || 0) + 1;
    }
    if (i < jdWords.length - 2) {
      const w3 = jdWords[i + 2];
      if (!STOPWORDS.has(w1) && !STOPWORDS.has(w3) && w1.length > 2 && w2.length > 2 && w3.length > 2) {
        const phrase3 = `${w1} ${w2} ${w3}`;
        phraseFreq[phrase3] = (phraseFreq[phrase3] || 0) + 1;
      }
    }
  }

  // Collect multi-word phrases: appear 2+ times OR are in the known list (1+ times)
  const multiPhrases = Object.entries(phraseFreq)
    .filter(([phrase, freq]) => freq >= 2 || KNOWN_PHRASES.has(phrase))
    .map(([phrase]) => phrase);

  // Deduplicate: prefer multi-word phrases, drop constituent unigrams they cover
  const coveredByPhrase = new Set();
  for (const phrase of multiPhrases) {
    phrase.split(" ").forEach(w => coveredByPhrase.add(w));
  }

  // Final keyword list: multi-word phrases + unigrams not covered by a phrase
  const candidates = [
    ...multiPhrases,
    ...unigrams.filter(w => !coveredByPhrase.has(w)),
  ];

  // Deduplicate
  const keywords = [...new Set(candidates)];

  // Check presence in resume
  const present = [];
  const missing = [];

  for (const kw of keywords) {
    if (resumeLower.includes(kw)) {
      present.push(kw);
    } else {
      missing.push(kw);
    }
  }

  const total = keywords.length;
  const score = total === 0 ? 0 : Math.round((present.length / total) * 100);

  // Sort missing by JD frequency (most-mentioned first) for top 10
  const sortedMissing = missing.sort((a, b) => {
    const freqA = a.includes(" ")
      ? (phraseFreq[a] || 0)
      : (wordFreq[a] || 0);
    const freqB = b.includes(" ")
      ? (phraseFreq[b] || 0)
      : (wordFreq[b] || 0);
    return freqB - freqA;
  }).slice(0, 10);

  // Top 5 present (by JD frequency)
  const sortedPresent = present.sort((a, b) => {
    const freqA = a.includes(" ") ? (phraseFreq[a] || 0) : (wordFreq[a] || 0);
    const freqB = b.includes(" ") ? (phraseFreq[b] || 0) : (wordFreq[b] || 0);
    return freqB - freqA;
  }).slice(0, 5);

  return {
    score,
    missing: sortedMissing,
    present: sortedPresent,
    total,
  };
}

// ─── HTML stripping helper ────────────────────────────────────────────────────
function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#039;/gi, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Free ATS score — no Claude, no payment
app.post("/ats-score", async (req, res) => {
  const { resume, jobDescription: jobDescriptionRaw, jobUrl } = req.body;

  if (!resume || (!jobDescriptionRaw && !jobUrl)) {
    return res.status(400).json({ error: "Resume and job description (or URL) are required." });
  }

  let jobDescription = jobDescriptionRaw || "";

  if (jobUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let fetchRes;
      try {
        fetchRes = await fetch(jobUrl, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ResumeSucks/1.0)" },
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
      const html = await fetchRes.text();
      jobDescription = stripHtml(html).slice(0, 4000);
    } catch (err) {
      console.error("Failed to fetch job URL:", err.message);
      return res.status(422).json({
        error: "Couldn't fetch that URL. Please paste the job description as text instead.",
      });
    }
  }

  if (resume.length > 15000 || jobDescription.length > 8000) {
    return res.status(400).json({ error: "Resume must be under 15,000 characters and job description under 8,000. Please trim and try again." });
  }

  const { score, missing, present, total } = computeAtsScore(resume, jobDescription);

  const id = require("crypto").randomBytes(16).toString("hex");

  stmtAtsInsert.run({
    id,
    resume,
    job_description: jobDescription,
    score,
    missing_keywords: JSON.stringify(missing),
    created_at: Date.now(),
  });

  res.json({ id, score, missing, present, total });
});

// Create Stripe Checkout session
app.post("/create-checkout-session", async (req, res) => {
  const { atsId } = req.body;

  // If atsId is provided, load resume + job_description from ats_checks
  let resume = req.body.resume;
  let jobDescriptionRaw = req.body.jobDescription;
  let jobUrl = req.body.jobUrl;

  if (atsId) {
    const atsRow = stmtAtsGet.get(atsId);
    if (!atsRow) {
      return res.status(404).json({ error: "ATS check not found or expired." });
    }
    resume = atsRow.resume;
    jobDescriptionRaw = atsRow.job_description;
    jobUrl = null; // already resolved
  }

  if (!resume || (!jobDescriptionRaw && !jobUrl)) {
    return res.status(400).json({ error: "Resume and job description (or URL) are required." });
  }

  let jobDescription = jobDescriptionRaw || "";

  // If a URL was provided instead of pasted text, fetch and extract it
  if (jobUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      let fetchRes;
      try {
        fetchRes = await fetch(jobUrl, {
          signal: controller.signal,
          headers: { "User-Agent": "Mozilla/5.0 (compatible; ResumeSucks/1.0)" },
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!fetchRes.ok) throw new Error(`HTTP ${fetchRes.status}`);
      const html = await fetchRes.text();
      const text = stripHtml(html);
      jobDescription = text.slice(0, 4000);
    } catch (err) {
      console.error("Failed to fetch job URL:", err.message);
      return res.status(422).json({
        error: "Couldn't fetch that URL. Please paste the job description as text instead.",
      });
    }
  }

  if (resume.length > 15000 || jobDescription.length > 8000) {
    return res.status(400).json({ error: "Resume must be under 15,000 characters and job description under 8,000. Please trim and try again." });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: "Resume Roast & Rewrite",
              description: "AI-powered brutal resume review + professional rewrite",
            },
            unit_amount: 900,
          },
          quantity: 1,
        },
      ],
      mode: "payment",
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      customer_creation: "if_required",
      phone_number_collection: { enabled: false },
      success_url: `${req.protocol}://${req.get("host")}/result.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get("host")}/`,
    });

    stmtInsert.run({
      id: session.id,
      resume,
      job_description: jobDescription,
      email: null,
      paid: 0,
      result: null,
      ats_id: atsId || null,
      created_at: Date.now(),
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Stripe session creation failed:", err.message);
    res.status(500).json({ error: "Failed to create checkout session." });
  }
});

// Get roast result (async with polling)
app.get("/api/result", async (req, res) => {
  const { session_id } = req.query;

  if (!session_id) {
    return res.status(400).json({ error: "Missing session_id." });
  }

  const job = stmtGet.get(session_id);
  if (!job) {
    return res.status(404).json({ error: "Session not found. It may have expired." });
  }

  // Verify payment with Stripe directly
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== "paid") {
      return res.status(402).json({ error: "Payment not completed." });
    }
    // Capture email if not yet stored (webhook may have fired already, but just in case)
    if (!job.email && session.customer_details?.email) {
      stmtUpdate.run({ paid: 1, email: session.customer_details.email, id: session_id });
    }
  } catch (err) {
    console.error("Stripe session retrieval failed:", err.message);
    return res.status(500).json({ error: "Failed to verify payment." });
  }

  // If result already ready, return it
  if (job.result) {
    // Get beforeScore from ats_checks if ats_id exists
    let beforeScore = null;
    if (job.ats_id) {
      const atsRow = stmtAtsGet.get(job.ats_id);
      if (atsRow) beforeScore = atsRow.score;
    }
    const afterScore = job.after_ats_score != null ? job.after_ats_score : null;
    return res.json({ status: "ready", result: job.result, beforeScore, afterScore });
  }

  // If already generating, report status
  if (generating.has(session_id)) {
    return res.json({ status: "generating" });
  }

  // Kick off async generation
  generating.add(session_id);
  res.json({ status: "generating" });

  // Fire and forget — generate in background
  (async () => {
    try {
      const message = await anthropic.messages.create({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4096,
        system:
          "You are a savage but brilliant career coach who has seen thousands of resumes and has zero patience for mediocrity. You roast resumes like a comedian roasts a celebrity — cutting, specific, and brutally funny — but underneath the burn is genuine expertise that actually helps people get hired. You call out BS corporate speak, vague achievements, and lazy formatting without mercy. You're not cruel for the sake of it — you're the friend who tells you that spinach is in your teeth before the interview, not after. Pull no punches. Make them wince, then make them better. CRITICAL RULE: When rewriting the resume, you work ONLY with what the candidate has given you. Do not invent metrics, fabricate achievements, add jobs they didn't have, or make up skills they didn't list. Your job is to reframe, sharpen, and restructure what's already there — not to lie on their behalf. If there are no numbers, say so in the roast and help them find real ones from their actual experience. Honesty is the whole point. You also help candidates articulate why they're harder to replace with AI than their peers — specific, credible, not generic.",
        messages: [
          {
            role: "user",
            content: `Here is the resume:\n${job.resume}\n\nHere is the job description they are targeting:\n${job.job_description}\n\nPlease provide:\n\n1. **ATS KEYWORD ANALYSIS** - Most resumes get filtered by Applicant Tracking Systems before a human ever reads them. Analyze this resume against the job description like an ATS would. Provide:\n   - An ATS match score (0-100%) based on keyword coverage\n   - The top 8-12 keywords/phrases from the job description that are MISSING from the resume (be specific: exact phrases, technical skills, tools, methodologies, job titles mentioned)\n   - The top 5 keywords already present (quick wins to acknowledge)\n   - 3 specific sentences they should add or rewrite to improve their ATS score, with the exact keywords inserted naturally\n   Be precise and specific — this is the section that explains why they're getting ghosted.\n\n2. **THE ROAST** - 5-7 specific, savage observations about what is weak, embarrassing, or actively hurting this resume for THIS specific job. Be merciless and specific — no generic advice. Call out exact phrases, missing numbers, vague claims, and anything that would make a hiring manager roll their eyes. Use dry humor where it lands naturally. Don't hold back.\n\n3. **THE FIX** - A fully rewritten, optimized version of their resume tailored for this exact job. Transform it from forgettable to compelling. Show don't tell — rewrite their actual bullet points with real impact.\n\n4. **TOP 3 WINS** - 3 things they actually did right that they should keep. Be genuine here — no fake positivity, only real strengths worth keeping.\n\n5. **YOUR AI-PROOF CASE** - This is 2026. Every hiring manager is wondering if they should just use AI instead of hiring a human. Based on this specific resume and this specific job, write 3-5 sharp, specific reasons why THIS person is harder to replace with AI than a typical candidate. Don't be generic ("humans are creative!") — be specific to their actual experience and the actual role. Call out real things: domain relationships, institutional knowledge, physical presence requirements, judgment in ambiguous situations, client trust, team dynamics, things that require being a specific human in a specific context. If their resume doesn't give you enough to work with, say so in the roast and tell them what to add to make their AI-proof case stronger.\n\nFormat it clearly with those five sections. Don't soften the roast with disclaimers — they paid for the truth.`,
          },
        ],
      });

      const result = message.content[0].text;

      // Extract the rewritten resume from THE FIX section
      const fixMatch = result.match(/(?:^|\n)[#*\s]*(?:\d+\.?\s*)?(?:\*\*)?THE FIX(?:\*\*)?\s*[-–]?[^\n]*\n([\s\S]*?)(?=\n[#*\s]*(?:\d+\.?\s*)?(?:\*\*)?TOP\s+3|\n[#*\s]*(?:\d+\.?\s*)?(?:\*\*)?YOUR AI|$)/i);
      const rewrittenResume = fixMatch ? fixMatch[1].trim() : null;

      // Compute after score if we have the rewritten resume and job description
      let afterScore = null;
      if (rewrittenResume && job.job_description) {
        const afterAts = computeAtsScore(rewrittenResume, job.job_description);
        afterScore = afterAts.score;
      }

      stmtResult.run({ result, after_ats_score: afterScore, id: session_id });

      // Generate .docx from rewritten resume and send email
      const freshJob = stmtGet.get(session_id);
      if (freshJob?.email) {
        let docxBuffer = null;
        if (rewrittenResume) {
          try { docxBuffer = await generateResumeDocx(rewrittenResume); } catch (e) { console.error("docx generation failed:", e.message); }
        }
        await sendRoastEmail(freshJob.email, result, docxBuffer);
      }
    } catch (err) {
      console.error("Claude API call failed:", err.message);
    } finally {
      generating.delete(session_id);
    }
  })();
});


// ─── Download rewritten resume as .docx ──────────────────────────────────────
app.get("/download-resume/:id", async (req, res) => {
  const job = stmtGet.get(req.params.id);
  if (!job || !job.paid || !job.result) return res.status(404).send("Not found");

  // Extract THE FIX section
  const fixMatch = job.result.match(/##\s*(?:3\.?\s*)?THE FIX[\s\S]*?\n([\s\S]*?)(?=\n##\s*(?:4\.?\s*)?TOP|\n##\s*(?:5\.?\s*)?YOUR|$)/i);
  const rewrittenResume = fixMatch ? fixMatch[1].trim() : job.result;

  try {
    const buf = await generateResumeDocx(rewrittenResume);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    res.setHeader("Content-Disposition", "attachment; filename=\"resume-rewritten.docx\"");
    res.send(buf);
  } catch (err) {
    console.error("docx download failed:", err.message);
    res.status(500).send("Could not generate file");
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`RoastMyResume running on http://localhost:${PORT}`);
});
