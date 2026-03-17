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

// Add before_ats_score column (fresh Haiku score, consistent with after_ats_score)
try {
  db.exec(`ALTER TABLE jobs ADD COLUMN before_ats_score INTEGER`);
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
const stmtResult = db.prepare(`UPDATE jobs SET result = @result, before_ats_score = @before_ats_score, after_ats_score = @after_ats_score WHERE id = @id`);
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
  const children = [
    new Paragraph({
      children: [
        new TextRun({
          text: "⚠️ DRAFT — Review before sending.",
          bold: true,
          size: 20,
          color: "CC7700",
        }),
        new TextRun({
          text: " This resume was rewritten by AI based on your original content. Read it carefully and remove anything that doesn't accurately reflect your real experience.",
          size: 20,
          color: "CC7700",
        }),
      ],
      spacing: { after: 200 },
      border: {
        top:    { style: BorderStyle.SINGLE, size: 6, color: "CC7700" },
        bottom: { style: BorderStyle.SINGLE, size: 6, color: "CC7700" },
        left:   { style: BorderStyle.SINGLE, size: 6, color: "CC7700" },
        right:  { style: BorderStyle.SINGLE, size: 6, color: "CC7700" },
      },
    }),
  ];

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
    <p style="color:#888;margin:0 0 32px">Here's what our career coach thinks. Brace yourself.</p>
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

// ─── ATS Score computation — Claude Haiku extracts keywords, we do the matching ─

const STOPWORDS = new Set([
  // Articles, conjunctions, prepositions
  "a","an","the","and","or","but","nor","so","yet","for","both","either","neither",
  "is","are","was","were","be","been","being","am",
  "have","has","had","do","does","did","will","would","shall","should","may",
  "might","must","can","could","to","of","in","on","at","by","for","with",
  "about","against","between","into","through","during","before","after",
  "above","below","from","up","down","out","off","over","under","again",
  "further","then","once","here","there","when","where","why","how",
  "all","both","each","few","more","most","other","some","such",
  "no","not","only","own","same","so","than","too","very","just",
  "that","this","these","those","such","which","what","who","whom","whose",
  "i","we","you","he","she","it","they","me","him","her","us","them",
  "as","if","while","although","because","since","unless","until","though",
  "their","our","your","his","its","my","any","well","also",
  // Generic verbs (filler in JDs)
  "use","used","using","work","working","works","ensure","help","helps","helping",
  "make","makes","making","build","builds","building","create","creates","creating",
  "develop","develops","developing","manage","manages","managing","lead","leads","leading",
  "drive","drives","driving","define","defines","defining","run","runs","running",
  "get","gets","getting","set","sets","setting","stay","stays","grow","grows","growing",
  "take","takes","taking","bring","brings","bringing","put","puts","keep","keeps",
  "join","joins","joining","provide","provides","providing","support","supports","supporting",
  "include","includes","including","apply","applies","applying","maintain","maintains",
  "maintain","review","reviews","reviewing","report","reports","reporting","perform","performs",
  "want","wants","seeking","looking","find","finds","finding","know","knows","knowing",
  "need","needs","needing","require","requires","requiring","expect","expects",
  "give","gives","giving","hold","holds","holding","communicate","communicates",
  "collaborate","collaborates","partner","partners","partnering","deliver","delivers","delivering",
  // Adverbs (almost never meaningful ATS keywords)
  "quickly","directly","effectively","efficiently","successfully","consistently","regularly",
  "rapidly","closely","clearly","highly","deeply","broadly","specifically","primarily",
  "generally","typically","currently","previously","recently","actively","proactively",
  "independently","collaboratively","continuously","constantly","frequently","occasionally",
  "potentially","approximately","significantly","substantially","largely","mainly","mostly",
  "well","also","already","often","always","never","sometimes","usually","normally",
  // Generic adjectives
  "annual","monthly","weekly","daily","ongoing","immediate","immediate","overall","general",
  "global","local","national","internal","external","various","multiple","different","diverse",
  "key","strong","excellent","great","good","new","high","large","small","big","wide",
  "broad","deep","complex","simple","clear","open","closed","public","private","shared",
  "fast","quick","dynamic","innovative","creative","strategic","tactical","operational",
  "dedicated","passionate","motivated","driven","results","oriented","focused","based",
  "competitive","flexible","scalable","reliable","robust","secure","efficient","effective",
  // Generic nouns (not skills)
  "job","role","position","career","opportunity","team","company","startup","organization",
  "person","people","individual","member","members","employee","employees","staff","hire",
  "way","ways","area","areas","type","types","kind","kinds","form","forms","part","parts",
  "range","set","list","group","groups","number","numbers","amount","level","levels",
  "time","times","day","days","week","weeks","month","months","year","years",
  "goal","goals","impact","value","values","result","results","outcome","outcomes",
  "process","processes","system","systems","solution","solutions","approach","approaches",
  "work","works","job","task","tasks","project","projects","initiative","initiatives",
  "plan","plans","strategy","strategies","decision","decisions","problem","problems",
  "idea","ideas","concept","concepts","point","points","case","cases","example","examples",
  "basis","detail","details","aspect","aspects","factor","factors","issue","issues",
  // HR/JD filler
  "required","must","need","candidate","candidates","ideal","preferred","plus","minimum",
  "least","one","two","three","four","five","six","seven","eight","nine","ten",
  "senior","junior","mid","level","remote","hybrid","onsite","full","part","contract",
  "permanent","etc","applicant","applicants","responsible","responsibilities",
  "requirement","requirements","qualifications","qualification","desired",
  "related","relevant","similar","equivalent","proven","demonstrated","ability","able",
  "comfortable","familiar","knowledge","background","track","record","prior","previous",
  "please","submit","send","equal","employer","benefits","compensation","salary","pay",
  "bonus","equity","vacation","pto","perks","culture","mission","vision","values",
  "about","office","location","travel","visa","sponsorship","authorization",
  // Words that appear constantly in JDs but are NEVER real ATS keywords
  "experience","experiences","experienced","without","within","including","following",
  "working","through","between","during","against","toward","towards","beside",
  "beside","besides","despite","except","instead","outside","inside","around",
  "production","products","product","service","services","business","businesses",
  "industry","industries","sector","market","markets","space","spaces",
  "someone","everyone","anyone","something","everything","anything","nothing",
  "someone","ourselves","yourself","together","another","others","whether",
  "specific","general","various","certain","possible","available","existing",
  "different","similar","standard","common","normal","regular","typical","usual",
  "technical","professional","personal","additional","potential","original",
  "current","future","recent","early","latest","modern","advanced","basic",
  "initial","final","primary","secondary","tertiary","respective","following",
  "ensure","ensures","ensuring","provide","provides","provided","providing",
  "across","around","behind","beneath","alongside","regarding","concerning",
  "helping","making","taking","giving","finding","building","leading","driving",
  "growing","staying","keeping","running","setting","getting","putting","holding",
  "skills","talent","talents","hiring","culture","impact","growth","success",
  "quality","delivery","execution","ownership","accountability","transparency",
  "passion","energy","mindset","attitude","approach","thinking","learning",
  "design","designs","designer","designing","research","researcher","researching",
  "report","reports","reporting","analysis","analyses","analyst","analyzing",
  "review","reviews","reviewer","reviewing","planning","plans","planner",
  "writing","written","writer","reading","speaker","speaking","presenter",
  "testing","tester","testing","debugging","troubleshoot","troubleshooting",
]);

// Short tech terms that should be treated as keywords even though they're short
const TECH_WHITELIST = new Set([
  // Languages
  "sql","css","php","lua","r","go","c","c++","c#","f#",
  // Cloud/infra
  "aws","gcp","azure","vpc","cdn","dns","ssl","tls","ssh","ftp","tcp","udp","http","https",
  "s3","ec2","rds","ecs","eks","emr","sns","sqs","iam","vpc",
  // Tools/tech
  "api","sdk","ide","orm","cli","gui","crm","cms","erp","sap","etl","elt",
  "git","svn","npm","pip","brew","vim","bash","zsh","curl","grep","awk",
  // Frameworks/libs (short names)
  "vue","ios","ml","ai","bi","qa","ui","ux",
  // Methodologies
  "tdd","bdd","ddd","oop","mvc","mvp","mvvm","soa","sre",
  // Data
  "csv","json","xml","yaml","toml","grpc","soap","rest",
]);

// Patterns that indicate a word is NOT a meaningful ATS keyword
const JUNK_PATTERNS = [
  /ly$/,          // adverbs: quickly, directly, efficiently, etc.
  /ness$/,        // abstract nouns: effectiveness, readiness
  /ment$/,        // generic: improvement, development (unless in phrase)
  /^[0-9]+$/,     // pure numbers
];

// Synonym/alias map: if JD has key, also check resume for any of the values
const SYNONYMS = {
  "machine learning":       ["ml"],
  "artificial intelligence":["ai"],
  "javascript":             ["js"],
  "typescript":             ["ts"],
  "python":                 ["py"],
  "kubernetes":             ["k8s"],
  "amazon web services":    ["aws"],
  "google cloud platform":  ["gcp"],
  "continuous integration": ["ci"],
  "continuous deployment":  ["cd"],
  "ci/cd":                  ["ci cd","cicd","continuous integration","continuous deployment"],
  "react":                  ["react.js","reactjs","react native"],
  "node":                   ["node.js","nodejs"],
  "next":                   ["next.js","nextjs"],
  "vue":                    ["vue.js","vuejs"],
  "angular":                ["angularjs"],
  "postgresql":             ["postgres"],
  "elasticsearch":          ["elastic search"],
  "mongodb":                ["mongo"],
  "github":                 ["git hub"],
  "gitlab":                 ["git lab"],
  "user experience":        ["ux"],
  "user interface":         ["ui"],
  "search engine optimization": ["seo"],
  "pay per click":          ["ppc"],
  "application programming interface": ["api"],
  "large language model":   ["llm","llms"],
  "retrieval augmented generation": ["rag"],
};

function isJunkWord(word) {
  if (TECH_WHITELIST.has(word)) return false;
  for (const pattern of JUNK_PATTERNS) {
    if (pattern.test(word)) return true;
  }
  return false;
}

function resumeContains(resumeLower, keyword) {
  if (resumeLower.includes(keyword)) return true;
  // Check synonyms
  const aliases = SYNONYMS[keyword];
  if (aliases) {
    for (const alias of aliases) {
      if (resumeLower.includes(alias)) return true;
    }
  }
  // Reverse: check if keyword is an alias for something else
  for (const [canonical, aliasList] of Object.entries(SYNONYMS)) {
    if (aliasList.includes(keyword) && resumeLower.includes(canonical)) return true;
  }
  return false;
}

// Use Claude Haiku to extract keywords AND semantically match them against the resume
// This handles cases like "LLM" matching "llm-native features", "Claude API" matching "claude", etc.
async function computeAtsScore(resume, jobDescription) {
  try {
    const msg = await anthropic.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `You are an ATS (Applicant Tracking System) analyzer. Given a job description and a resume, identify the most important keywords/skills from the job description and determine which ones are present or absent in the resume.

Use semantic matching — "LLM" in a resume counts as matching "llm-native features", "prompt engineering experience" counts as matching "prompt engineering", "built with Claude API" counts as matching "claude", etc.

Return ONLY valid JSON in this exact format, no explanation:
{
  "present": ["keyword1", "keyword2"],
  "missing": ["keyword3", "keyword4"]
}

Rules:
- Extract 10-15 total keywords from the job description
- Only include specific skills, tools, technologies, methodologies, domain terms
- No generic words (experience, skills, team, work, etc.)
- present = keywords that ARE in the resume (exact or semantic match)
- missing = keywords that are NOT in the resume at all
- Keep keyword labels concise and readable (e.g. "prompt engineering" not "strong prompt engineering skills")

JOB DESCRIPTION:
${jobDescription.slice(0, 3000)}

RESUME:
${resume.slice(0, 3000)}`
      }]
    });

    const text = msg.content[0].text.trim();
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { score: 0, missing: [], present: [], total: 0 };

    const parsed = JSON.parse(match[0]);
    const present = Array.isArray(parsed.present) ? parsed.present.map(k => k.toLowerCase().trim()) : [];
    const missing = Array.isArray(parsed.missing) ? parsed.missing.map(k => k.toLowerCase().trim()) : [];
    const total = present.length + missing.length;
    const score = total === 0 ? 0 : Math.round((present.length / total) * 100);

    return {
      score,
      missing: missing.slice(0, 10),
      present: present.slice(0, 5),
      total,
    };
  } catch (err) {
    console.error("Haiku ATS scoring failed:", err.message);
    return { score: 0, missing: [], present: [], total: 0 };
  }
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

// Free ATS score — Claude Haiku extracts keywords, we match against resume
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

  const { score, missing, present, total } = await computeAtsScore(resume, jobDescription);

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
    const beforeScore = job.before_ats_score != null ? job.before_ats_score : null;
    const afterScore  = job.after_ats_score  != null ? job.after_ats_score  : null;
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
          `REWRITE RULES — READ FIRST, FOLLOW ALWAYS:
You are rewriting a real person's resume. The following are HARD rules that override everything else:
1. DO NOT add any skill, technology, tool, project, job, achievement, or responsibility that is not already present in the original resume text. If it's not there, it doesn't go in the rewrite. Period.
2. DO NOT invent metrics or numbers. If the resume says "improved performance", you may rewrite it as "improved performance" — you may NOT rewrite it as "improved performance by 40%".
3. DO NOT add job titles, company names, or work experiences that don't exist in the original.
4. If the job description requires a skill or technology that is completely absent from the resume, call it out in the ROAST. Tell them to add it if they genuinely have the experience. Do not silently slip it into the rewrite.
5. Your job is to SHARPEN and RESTRUCTURE what already exists — better verbs, clearer framing, stronger language — not to manufacture a new resume from thin air.

Violations of these rules cause real harm: people get hired for jobs they're not qualified for, fail probation, and lose trust. Don't lie on their behalf.

---

You are a savage but brilliant career coach who has seen thousands of resumes and has zero patience for mediocrity. You roast resumes like a comedian roasts a celebrity — cutting, specific, and brutally funny — but underneath the burn is genuine expertise that actually helps people get hired. You call out BS corporate speak, vague achievements, and lazy formatting without mercy. You're not cruel for the sake of it — you're the friend who tells you that spinach is in your teeth before the interview, not after. Pull no punches. Make them wince, then make them better. You also help candidates articulate why they're harder to replace with AI than their peers — specific, credible, not generic.`,
        messages: [
          {
            role: "user",
            content: `Here is the resume:\n${job.resume}\n\nHere is the job description they are targeting:\n${job.job_description}\n\nPlease provide:\n\n1. **ATS KEYWORD ANALYSIS** - Most resumes get filtered by Applicant Tracking Systems before a human ever reads them. Analyze this resume against the job description like an ATS would. Provide:\n   - DO NOT output a numerical ATS score or percentage — that is calculated separately by our system. Do not write things like "ATS Match Score: X%". Skip any score number entirely.\n   - The top 8-12 keywords/phrases from the job description that are MISSING from the resume (be specific: exact phrases, technical skills, tools, methodologies, job titles mentioned)\n   - The top 5 keywords already present (quick wins to acknowledge)\n   - 3 specific sentences they should add or rewrite to improve their ATS score, with the exact keywords inserted naturally. ONLY suggest adding keywords that reflect real experience from the resume — do not suggest adding skills or technologies that are completely absent from their background.\n   Be precise and specific — this is the section that explains why they're getting ghosted.\n\n2. **THE ROAST** - 5-7 specific, savage observations about what is weak, embarrassing, or actively hurting this resume for THIS specific job. Be merciless and specific — no generic advice. Call out exact phrases, missing numbers, vague claims, and anything that would make a hiring manager roll their eyes. Use dry humor where it lands naturally. Don't hold back.\n\n3. **THE FIX** - A fully rewritten, optimized version of their resume tailored for this exact job. REMEMBER: you may only use skills, technologies, jobs, and experiences that appear in the original resume above. Do not add anything new. Sharpen and reframe what exists.\n\n4. **TOP 3 WINS** - 3 things they actually did right that they should keep. Be genuine here — no fake positivity, only real strengths worth keeping.\n\n5. **YOUR AI-PROOF CASE** - This is 2026. Every hiring manager is wondering if they should just use AI instead of hiring a human. Based on this specific resume and this specific job, write 3-5 sharp, specific reasons why THIS person is harder to replace with AI than a typical candidate. Don't be generic ("humans are creative!") — be specific to their actual experience and the actual role. Call out real things: domain relationships, institutional knowledge, physical presence requirements, judgment in ambiguous situations, client trust, team dynamics, things that require being a specific human in a specific context. If their resume doesn't give you enough to work with, say so in the roast and tell them what to add to make their AI-proof case stronger.\n\nFormat it clearly with those five sections. Don't soften the roast with disclaimers — they paid for the truth.`,
          },
        ],
      });

      const result = message.content[0].text;

      // Extract the rewritten resume from THE FIX section
      const fixMatch = result.match(/(?:^|\n)[#*\s]*(?:\d+\.?\s*)?(?:\*\*)?THE FIX(?:\*\*)?\s*[-–]?[^\n]*\n([\s\S]*?)(?=\n[#*\s]*(?:\d+\.?\s*)?(?:\*\*)?TOP\s+3|\n[#*\s]*(?:\d+\.?\s*)?(?:\*\*)?YOUR AI|$)/i);
      const rewrittenResume = fixMatch ? fixMatch[1].trim() : null;

      // Compute before + after scores using the same Haiku method — apples to apples
      let beforeScore = null;
      let afterScore = null;
      if (job.job_description) {
        const [beforeAts, afterAts] = await Promise.all([
          computeAtsScore(job.resume, job.job_description),
          rewrittenResume ? computeAtsScore(rewrittenResume, job.job_description) : Promise.resolve({ score: null }),
        ]);
        beforeScore = beforeAts.score;
        afterScore  = afterAts.score;
      }

      stmtResult.run({ result, before_ats_score: beforeScore, after_ats_score: afterScore, id: session_id });

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
