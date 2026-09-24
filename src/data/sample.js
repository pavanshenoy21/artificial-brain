// Sample brain: seeds the browser mock backend and "Import sample data".
// Shape:
//   { nodes: [{ id, type, lobe, title, tags, ...fields }], links: [{ source, target, kind }] }
// kind: "explicit" = a link you made yourself, "similar" = computed by shared tags / embeddings.

export const LOBES = [
  { id: "sec", name: "Security & CTF",          color: "#e06c75" },
  { id: "web", name: "Web & Apps",              color: "#56b6c2" },
  { id: "ai",  name: "AI & ML",                 color: "#a98fe0" },
  { id: "cp",  name: "Competitive Programming", color: "#d6a64f" },
  { id: "sys", name: "Linux & Systems",         color: "#7fb77e" },
  { id: "col", name: "College & Life",          color: "#d98a5f" },
];

let seq = 0;
const nodes = [];
function n(type, lobe, title, tags, fields = {}) {
  const id = `${type}-${++seq}`;
  nodes.push({ id, type, lobe, title, tags, ...fields });
  return id;
}

// ---------- Security & CTF ----------
const ctfChecklist = n("note", "sec", "CTF challenge design checklist", ["ctf", "challenge-design"], { body: "Every challenge needs: an intended path, a tested solve script, a flag format check, and a note on unintended solutions. Difficulty should come from the idea, not from guessing." });
const ctfdNotes    = n("note", "sec", "CTFd deployment notes", ["ctf", "docker", "infra"], { body: "Run CTFd behind nginx with docker compose. Keep uploads on a volume. Back up the database before every event." });
const hackemon     = n("project", "sec", "Hackemon", ["ctf", "infra", "docker"], { repo: "github.com/…/hackemon", stack: ["Docker", "CTFd", "Python"], status: "active" });
const webExploit   = n("skill", "sec", "Web exploitation (XSS, SQLi)", ["ctf", "web-security"], { level: "intermediate" });
const privesc      = n("skill", "sec", "Linux privilege escalation", ["ctf", "linux"], { level: "beginner" });
const portswigger  = n("link", "sec", "PortSwigger Web Security Academy", ["web-security", "learning"], { url: "https://portswigger.net/web-security", summary: "Free, hands-on labs for every major web vulnerability class." });
const gtfobins     = n("link", "sec", "GTFOBins", ["linux", "ctf"], { url: "https://gtfobins.github.io", summary: "Unix binaries that can be abused to bypass local security restrictions." });
const jwtWriteup   = n("note", "sec", "Writeup: JWT none-alg bypass", ["ctf", "web-security", "jwt"], { body: "Server accepted alg=none. Stripped the signature, set role=admin, got the flag. Fix: pin the algorithm on verify." });
const fmtWriteup   = n("note", "sec", "Writeup: format string leak", ["ctf", "pwn"], { body: "printf(user_input) leaked stack values with %p. Found the canary offset, then leaked the flag pointer with %s." });
const pwnSkill     = n("skill", "sec", "Binary exploitation basics", ["pwn", "ctf"], { level: "beginner" });
const pwncollege   = n("link", "sec", "pwn.college", ["pwn", "learning"], { url: "https://pwn.college", summary: "Structured course from memory errors up to kernel exploitation." });
const rsaIdeas     = n("note", "sec", "Crypto challenge ideas: small e RSA", ["ctf", "crypto", "challenge-design"], { body: "e=3 with no padding → cube root the ciphertext. Variant: same message to 3 recipients → Håstad broadcast." });
const cryptoSkill  = n("skill", "sec", "Cryptography basics", ["crypto"], { level: "beginner" });
const cryptohack   = n("link", "sec", "CryptoHack", ["crypto", "learning"], { url: "https://cryptohack.org", summary: "Gamified crypto challenges, great for RSA and ECC fundamentals." });
const collegeCtf   = n("hackathon", "sec", "College CTF (organizer)", ["ctf", "event"], { date: "2026", role: "Organizer", built: "Challenges + scoring infrastructure", stack: ["CTFd", "Docker"] });
const isolation    = n("note", "sec", "Per-team challenge containers", ["ctf", "docker", "infra"], { body: "Spawn one container per team on first request, kill after 30 min idle. Stops teams from breaking the box for each other." });

// ---------- Competitive Programming ----------
const cpRoutine  = n("note", "cp", "CP daily routine", ["cp", "habit"], { body: "One problem a day minimum. Read editorial only after 45 minutes. Log every mistake." });
const stl        = n("skill", "cp", "C++ STL", ["cpp", "cp"], { level: "intermediate" });
const binSearch  = n("skill", "cp", "Binary search on answer", ["algorithms", "cp"], { level: "intermediate" });
const prefix     = n("skill", "cp", "Prefix sums & sliding window", ["algorithms", "cp"], { level: "intermediate" });
const twoPtr     = n("note", "cp", "Two pointers patterns", ["algorithms"], { body: "Sorted array + pair sum, shrinking window for 'at most k', fast/slow for cycles." });
const graphCheat = n("note", "cp", "Graph BFS/DFS cheatsheet", ["graphs", "algorithms"], { body: "BFS for shortest path in unweighted graphs. DFS for components, cycles, topological order." });
const dp         = n("skill", "cp", "Dynamic programming (intro)", ["dp", "algorithms"], { level: "beginner" });
const cf         = n("link", "cp", "Codeforces", ["cp"], { url: "https://codeforces.com", summary: "Contests and a huge rated problem archive." });
const lc         = n("link", "cp", "LeetCode", ["cp"], { url: "https://leetcode.com", summary: "Interview-style problems, good for daily practice." });
const cses       = n("link", "cp", "CSES Problem Set", ["cp", "algorithms"], { url: "https://cses.fi/problemset", summary: "300 classic problems grouped by technique." });
const mistakes   = n("note", "cp", "Mistakes log: overflow & off-by-one", ["cpp", "debugging", "cp"], { body: "Use long long when multiplying two ints. Check loop bounds on the last index. Reset globals between test cases." });
const cpAlgo     = n("link", "cp", "cp-algorithms.com", ["algorithms", "learning"], { url: "https://cp-algorithms.com", summary: "Reference implementations and proofs for standard algorithms." });
const dijkstra   = n("note", "cp", "Dijkstra notes", ["graphs", "algorithms"], { body: "Priority queue of (dist, node). Skip stale entries. Doesn't work with negative edges." });

// ---------- Web & Apps ----------
const showcase   = n("project", "web", "Club Showcase Website", ["web", "frontend"], { repo: "github.com/…/club-showcase", stack: ["HTML", "CSS", "JavaScript"], status: "shipped" });
const onevision  = n("project", "web", "OneVision", ["web", "ai", "mobile"], { repo: "github.com/…/onevision", stack: ["JavaScript", "Vision API"], status: "shipped" });
const htmlcss    = n("skill", "web", "HTML / CSS / JavaScript", ["frontend", "web"], { level: "intermediate" });
const flask      = n("skill", "web", "Flask", ["backend", "python"], { level: "beginner" });
const react      = n("skill", "web", "React (basics)", ["frontend"], { level: "beginner" });
const threeDocs  = n("link", "web", "three.js docs", ["3d", "frontend"], { url: "https://threejs.org/docs", summary: "Reference for the 3D engine behind the graph view." });
const fg3d       = n("link", "web", "3d-force-graph", ["3d", "graph"], { url: "https://vasturiano.github.io/3d-force-graph/", summary: "Force-directed graphs in WebGL. The base of this app's graph view." });
const brainIdea  = n("note", "web", "Idea: Artificial Brain", ["knowledge-graph", "3d", "idea"], { body: "Obsidian but smarter and more visual. 3D graph with lobes, quick capture from anywhere, search with a travel animation, an AI agent living inside it." });
const tauriNote  = n("note", "web", "Tauri vs Electron", ["desktop", "decision"], { body: "Tauri: tiny binaries, Rust backend, uses the system webview. Electron: bundles Chromium, heavier. Picked Tauri for the brain." });
const tauriDocs  = n("link", "web", "Tauri v2 docs", ["desktop"], { url: "https://v2.tauri.app", summary: "Cross-platform desktop apps with a web frontend and a Rust core." });
const ovHack     = n("hackathon", "web", "Hackathon: OneVision", ["web", "ai", "event"], { date: "2026", role: "Builder", built: "One-button AI camera assistant as a single-file mobile web app", stack: ["JavaScript"] });
const travelAnim = n("note", "web", "Search animation: file travels to the UI", ["3d", "ux", "idea"], { body: "Selected result flies from its spot in the graph into the side panel. Keep it under ~400–800 ms and skippable." });
const refUI      = n("link", "web", "Refactoring UI", ["design", "learning"], { url: "https://www.refactoringui.com", summary: "Practical UI design tactics for developers." });

// ---------- AI & ML ----------
const ocr        = n("project", "ai", "OCR Pipeline (Industry 4.0 EL)", ["ocr", "python"], { repo: "github.com/…/ocr-pipeline", stack: ["Python", "Tesseract"], status: "active" });
const jarvis     = n("project", "ai", "Jarvis (local life assistant)", ["llm", "rag"], { repo: "—", stack: ["llama.cpp", "Python"], status: "idea" });
const python     = n("skill", "ai", "Python", ["python"], { level: "intermediate" });
const prompting  = n("skill", "ai", "Prompt engineering", ["llm"], { level: "intermediate" });
const ragVsFt    = n("note", "ai", "RAG vs fine-tuning", ["llm", "rag"], { body: "Facts that change → RAG. Style or format → fine-tuning. For a personal brain, RAG over notes wins." });
const llamaSetup = n("note", "ai", "llama.cpp setup on Fedora", ["llm", "linux"], { body: "Build with cmake, grab a GGUF model, run llama-server. It exposes an OpenAI-compatible API on localhost." });
const llamaRepo  = n("link", "ai", "llama.cpp", ["llm"], { url: "https://github.com/ggml-org/llama.cpp", summary: "Local LLM inference in C/C++." });
const groq       = n("link", "ai", "Groq API", ["llm", "api"], { url: "https://console.groq.com", summary: "Very fast hosted inference with an OpenAI-compatible API. Candidate for 'polish this note'." });
const umapNote   = n("note", "ai", "Embeddings + UMAP for layout", ["embeddings", "graph", "3d"], { body: "Embed every note, reduce to 3D with UMAP, use it as the starting position, so similar notes land near each other." });
const umapDocs   = n("link", "ai", "UMAP docs", ["embeddings"], { url: "https://umap-learn.readthedocs.io", summary: "Dimensionality reduction that keeps local neighbourhoods intact." });
const tesseract  = n("skill", "ai", "Tesseract / OCR", ["ocr"], { level: "beginner" });
const toolCall   = n("note", "ai", "Tool calling: save_fact / get_fact", ["llm", "agent"], { body: "Let the model call tools for memory and math instead of doing arithmetic or remembering things itself." });
const projector  = n("link", "ai", "TensorFlow Embedding Projector", ["embeddings", "3d"], { url: "https://projector.tensorflow.org", summary: "Interactive 3D view of embedding spaces." });

// ---------- Linux & Systems ----------
const linux      = n("skill", "sys", "Linux (Fedora)", ["linux"], { level: "intermediate" });
const docker     = n("skill", "sys", "Docker", ["docker", "infra"], { level: "intermediate" });
const git        = n("skill", "sys", "Git & GitHub", ["git"], { level: "intermediate" });
const fedoraLog  = n("note", "sys", "Fedora setup log", ["linux", "setup"], { body: "dnf, RPM Fusion, codecs, dev tools group. Keep a list of everything installed so a reinstall takes 20 minutes." });
const gnomeKeys  = n("note", "sys", "GNOME custom shortcuts", ["linux", "desktop"], { body: "Settings → Keyboard → Custom Shortcuts. Candidate for the quick-capture window of the brain." });
const archWiki   = n("link", "sys", "Arch Wiki", ["linux", "learning"], { url: "https://wiki.archlinux.org", summary: "The best Linux documentation, useful on any distro." });
const bash       = n("note", "sys", "Bash one-liners", ["linux", "shell"], { body: "find . -name '*.log' -mtime +7 -delete · du -sh * | sort -h · xargs -P for parallel jobs." });
const networking = n("skill", "sys", "Networking basics", ["networking"], { level: "beginner" });
const sshTmux    = n("note", "sys", "SSH & tmux workflow", ["linux", "shell"], { body: "ssh config aliases, tmux sessions per project, detach instead of closing." });

// ---------- College & Life ----------
const ace        = n("project", "col", "Ace Designers BOM Accuracy", ["manufacturing", "team"], { repo: "—", stack: ["Python", "Excel"], status: "active" });
const sip        = n("note", "col", "SIP software report", ["sip", "report"], { body: "Everything used for the Student Induction Program: dashboard, attendance, ticketing, club showcase." });
const club       = n("note", "col", "Coding Club ideas", ["club", "idea"], { body: "Monthly CTF night, CP ladder, project demo day." });
const semPlan    = n("note", "col", "Semester plan", ["college", "planning"], { body: "Internals dates, lab submissions, EL milestones." });
const marks      = n("note", "col", "Internals marks tracker", ["college"], { body: "Track each internal. Work out what's needed in end-sem for the target grade." });
const reading    = n("note", "col", "Reading list", ["reading"], { body: "Essays and books to get through this semester." });
const pgEssay    = n("link", "col", "How to Do Great Work", ["reading"], { url: "https://paulgraham.com/greatwork.html", summary: "Essay on picking problems and following curiosity." });
const hackNight  = n("hackathon", "col", "Club Hack Night", ["event", "club"], { date: "2026", role: "Participant", built: "Quick internal tool prototype", stack: ["Flask"] });

// ---------- Explicit links (the ones you'd make yourself with [[wikilinks]]) ----------
const E = [
  [hackemon, ctfdNotes], [hackemon, isolation], [hackemon, docker], [hackemon, collegeCtf], [collegeCtf, ctfChecklist],
  [ctfChecklist, rsaIdeas], [ctfChecklist, jwtWriteup], [jwtWriteup, webExploit], [webExploit, portswigger],
  [fmtWriteup, pwnSkill], [pwnSkill, pwncollege], [rsaIdeas, cryptoSkill], [cryptoSkill, cryptohack],
  [privesc, gtfobins], [privesc, linux], [isolation, docker], [ctfdNotes, docker],
  [cpRoutine, lc], [cpRoutine, cf], [cpRoutine, mistakes], [mistakes, stl], [binSearch, cses], [prefix, twoPtr],
  [graphCheat, dijkstra], [graphCheat, cses], [dp, cpAlgo], [dijkstra, cpAlgo], [stl, cpRoutine],
  [showcase, htmlcss], [showcase, sip], [onevision, ovHack], [onevision, htmlcss], [onevision, prompting],
  [brainIdea, fg3d], [brainIdea, tauriNote], [brainIdea, travelAnim], [brainIdea, umapNote], [brainIdea, gnomeKeys],
  [brainIdea, groq], [fg3d, threeDocs], [tauriNote, tauriDocs], [travelAnim, threeDocs], [react, htmlcss], [flask, python],
  [ocr, tesseract], [ocr, python], [jarvis, ragVsFt], [jarvis, llamaSetup], [jarvis, toolCall], [llamaSetup, llamaRepo],
  [llamaSetup, linux], [umapNote, umapDocs], [umapNote, projector], [toolCall, prompting], [marks, jarvis],
  [linux, fedoraLog], [fedoraLog, gnomeKeys], [bash, sshTmux], [linux, archWiki], [docker, networking], [git, showcase],
  [ace, python], [sip, club], [club, collegeCtf], [club, cpRoutine], [semPlan, marks], [reading, pgEssay], [hackNight, flask],
  [hackNight, club],
];

// { nodes, links } with explicit links as edges. The Rust import (and the mock
// backend) turn those edges into "Related: [[...]]" lines in the source note.
export function buildSampleGraph() {
  return {
    nodes: nodes.map(x => ({ ...x })),
    links: E.map(([source, target]) => ({ source, target, kind: "explicit" })),
  };
}
