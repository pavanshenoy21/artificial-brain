// The sample vault ("Import sample data", and the browser preview's seed):
// plain markdown files in folders, exactly what an Obsidian vault looks like.
//
// Top-level folders are lobes (Coding Club, College, Projects, Learning);
// their subfolders are the coloured groups inside each lobe.

const notes = {
  "Welcome.md": `# Welcome

This vault is plain markdown in folders. Obsidian can open the same folder.

- Top-level folders are **lobes** in the graph: [[Coding Club/Overview|Coding Club]], College, Projects, Learning.
- Their subfolders get their own colour, and every note inside them takes it.
- Link notes with [[wikilinks]]; tag them with #tags.

Start with [[Overview]] or open the graph (Ctrl G).`,

  // ---------------------------------------------------------------- Coding Club
  "Coding Club/Overview.md": `# Coding Club

What the club runs every semester: [[CTF night]], hackathons like [[Hack Night 2026]], and [[Git workshop]].

#club`,
  "Coding Club/CTF/CTF night.md": `Monthly CTF night for juniors. Challenges follow the [[Challenge design checklist]] and run on [[CTFd setup]].

#ctf #club`,
  "Coding Club/CTF/Challenge design checklist.md": `Every challenge needs an intended path, a tested solve script, a flag format check and a note on unintended solutions.

Difficulty should come from the idea, not from guessing. See [[Writeup - JWT none alg]].

#ctf`,
  "Coding Club/CTF/CTFd setup.md": `CTFd behind nginx with docker compose. Keep uploads on a volume. Back up the database before every event.

Per-team containers: [[Per-team challenge containers]]. Needs [[Docker]].

#ctf #infra`,
  "Coding Club/CTF/Per-team challenge containers.md": `Spawn one container per team on first request, kill after 30 min idle. Stops teams from breaking the box for each other.

#ctf #infra`,
  "Coding Club/CTF/Writeup - JWT none alg.md": `The server accepted \`alg=none\`. Strip the signature, set role=admin, get the flag.

Fix: pin the algorithm on verify. Related: [[Web exploitation]].

#ctf #writeup`,
  "Coding Club/CTF/Writeup - format string.md": `\`printf(user_input)\` leaked stack values with %p. Found the canary offset, then leaked the flag pointer with %s.

#ctf #writeup #pwn`,
  "Coding Club/CTF/Small e RSA ideas.md": `e=3 with no padding → cube root the ciphertext. Variant: same message to 3 recipients → Håstad broadcast.

#ctf #crypto`,

  "Coding Club/Hackathons/Hack Night 2026.md": `---
date: 2026-03-14
role: Builder
---
Built a quick internal ticketing prototype with [[Flask]] in 6 hours.

Team retro: [[Hackathon retro template]].

#hackathon`,
  "Coding Club/Hackathons/OneVision hackathon.md": `---
date: 2026-02-02
role: Builder
---
One-button AI camera assistant as a single-file mobile web app. Became [[OneVision]].

#hackathon`,
  "Coding Club/Hackathons/College CTF (organiser).md": `Organised the college CTF: challenges + scoring infrastructure on [[CTFd setup]].

#hackathon #ctf`,
  "Coding Club/Hackathons/Hackathon retro template.md": `## What we built
## What broke
## What to try next time

#template`,

  "Coding Club/Workshops/Git workshop.md": `90 minutes: commits, branches, pull requests, fixing a merge conflict live. Slides reuse [[Git basics]].

#workshop`,
  "Coding Club/Workshops/Linux 101.md": `Shell, permissions, package managers. Uses [[Bash one-liners]] as exercises.

#workshop #linux`,

  // ---------------------------------------------------------------- College
  "College/Semester plan.md": `Internals dates, lab submissions, EL milestones.

- [ ] Revise paging and scheduling for the OS internal
- [ ] Submit the DSA lab record
- [x] Pick the EL topic

See [[Operating systems]] and [[Internals marks]].`,
  "College/Internals marks.md": `Track each internal and work out what's needed in the end-sem for the target grade.`,
  "College/Sem 3/Operating systems.md": `## Memory
Paging, page faults, TLB. Thrashing = more time paging than running.

## Deadlock
Mutual exclusion, hold and wait, no preemption, circular wait.

#os`,
  "College/Sem 3/Data structures.md": `Trees, heaps, hashing. Practise with [[Two pointers]] and [[Graph BFS DFS]].

#dsa`,
  "College/Sem 3/Discrete maths.md": `Relations, graphs, counting. Graph theory helps with [[Graph BFS DFS]].`,
  "College/Labs/DSA lab record.md": `Programs 1–10 done. 11 (AVL tree) left. Uses [[Data structures]].

#lab`,
  "College/Labs/OS lab.md": `Scheduling simulators in C. Notes in [[Operating systems]].

#lab`,

  // ---------------------------------------------------------------- Projects
  "Projects/Artificial Brain/Artificial Brain.md": `Obsidian on steroids: plain markdown vault + a 3D graph where folders are lobes.

Stack: Tauri, three.js, CodeMirror. See [[Tauri vs Electron]] and [[3D graph notes]].

#project`,
  "Projects/Artificial Brain/3D graph notes.md": `Lobes = top-level folders, shown only as coloured names. Subfolders are coloured chunks, connected as a tree under their lobe.`,
  "Projects/Artificial Brain/Tauri vs Electron.md": `Tauri: tiny binaries, Rust backend, system webview. Electron: bundles Chromium. Picked Tauri.`,
  "Projects/OneVision/OneVision.md": `Started at the [[OneVision hackathon]]. Camera → vision API → spoken answer.

#project`,
  "Projects/OneVision/Prompt notes.md": `Keep the system prompt short; describe one object, not the scene.`,
  "Projects/Club Website/Club Website.md": `Showcase site for the [[Overview|Coding Club]]: events, projects, members. Plain HTML/CSS/JS.

#project #web`,

  // ---------------------------------------------------------------- Learning
  "Learning/Linux/Fedora setup log.md": `dnf, RPM Fusion, codecs, dev tools group. Hyprland config lives in ~/.config/hypr.

#linux`,
  "Learning/Linux/Bash one-liners.md": "`find . -name '*.log' -mtime +7 -delete` · `du -sh * | sort -h` · `xargs -P` for parallel jobs.\n\n#linux #shell",
  "Learning/Linux/Docker.md": `Images, containers, volumes, compose. Used for [[CTFd setup]].

#infra`,
  "Learning/Linux/Git basics.md": `commit, branch, rebase, reflog to undo anything.

#git`,
  "Learning/CP/Two pointers.md": `Sorted array + pair sum, shrinking window for "at most k", fast/slow for cycles.

#cp`,
  "Learning/CP/Graph BFS DFS.md": `BFS for shortest path in unweighted graphs. DFS for components, cycles, topological order. Next: [[Dijkstra]].

#cp`,
  "Learning/CP/Dijkstra.md": `Priority queue of (dist, node). Skip stale entries. No negative edges.

#cp`,
  "Learning/Web/Flask.md": `Routes, templates, a SQLite file. Enough for hackathon prototypes.

#web`,
  "Learning/Web/Web exploitation.md": `XSS, SQLi, JWT mistakes. Practice on PortSwigger labs.

#web #ctf`,
};

const canvas = {
  nodes: [
    { id: "g-before", type: "group", label: "Before the event", x: -40, y: -60, width: 860, height: 620 },
    { id: "g-day", type: "group", label: "On the day", x: 900, y: -60, width: 560, height: 620, color: "4" },
    { id: "t-goal", type: "text", x: 0, y: 0, width: 360, height: 120,
      text: "## Goal\nRun a 24h CTF for ~40 teams with challenges that teach, not frustrate. #ctf" },
    { id: "f-check", type: "file", file: "Coding Club/CTF/Challenge design checklist.md", x: 420, y: 0, width: 360, height: 220 },
    { id: "f-rsa", type: "file", file: "Coding Club/CTF/Small e RSA ideas.md", x: 0, y: 180, width: 360, height: 200, color: "6" },
    { id: "t-todo", type: "text", x: 420, y: 280, width: 360, height: 220,
      text: "### To do\n- [ ] 3 web, 3 pwn, 2 crypto challenges\n- [ ] test every solve script\n- [ ] dry run with seniors\n\nSee [[Per-team challenge containers]]" },
    { id: "l-ctfd", type: "link", url: "https://ctfd.io", x: 0, y: 420, width: 360, height: 100 },
    { id: "f-deploy", type: "file", file: "Coding Club/CTF/CTFd setup.md", x: 940, y: 0, width: 480, height: 220 },
    { id: "t-day", type: "text", x: 940, y: 280, width: 480, height: 220, color: "2",
      text: "### Checklist\n1. Back up the database\n2. Watch the scoreboard and container load\n3. Announce hints at the 12h mark" },
  ],
  edges: [
    { id: "e1", fromNode: "t-goal", fromSide: "right", toNode: "f-check", toSide: "left", label: "every challenge" },
    { id: "e2", fromNode: "f-check", fromSide: "bottom", toNode: "t-todo", toSide: "top" },
    { id: "e3", fromNode: "f-rsa", fromSide: "right", toNode: "t-todo", toSide: "left" },
    { id: "e4", fromNode: "t-todo", fromSide: "right", toNode: "f-deploy", toSide: "left", label: "then deploy", color: "4" },
    { id: "e5", fromNode: "f-deploy", fromSide: "bottom", toNode: "t-day", toSide: "top" },
  ],
};

// Tab-indented JSON, the way Obsidian writes canvases.
const canvasText = () => JSON.stringify(canvas, null, "\t");

/** [{ path, content }] for every file in the sample vault. */
export function sampleFiles() {
  return [
    ...Object.entries(notes).map(([path, content]) => ({ path, content: content.endsWith("\n") ? content : content + "\n" })),
    { path: "Coding Club/CTF/CTF event plan.canvas", content: canvasText() },
  ];
}
