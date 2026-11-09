// Test vaults built through the API (on top of "?empty").

// Shaped like a real vault: lobes (top-level folders) with subfolders, links
// inside folders, and many links from every lobe into one busy lobe.
export async function buildVault(page) {
  await page.evaluate(async () => {
    const api = window.brain.api;
    const lobes = {
      Commands: ["Git", "Linux", "Docker"], "Sem 3": ["OS", "DSA", "Maths"], "Coding Club": ["CTF", "Workshops"],
      Hackathons: ["2025", "2026"], "ACE Project": ["Design", "Code"], SIP: ["Dashboard"], "EL SEM 3": ["Report"],
      "SEE Sem 2": ["Papers"], Misc: [], notes: [],
    };
    let i = 0;
    const all = [];
    for (const [lobe, subs] of Object.entries(lobes)) {
      const folders = subs.length ? subs.map(s => `${lobe}/${s}`) : [lobe];
      for (const f of folders)
        for (let k = 0; k < 5; k++) {
          const title = `${f.split("/").pop()} note ${++i}`;
          all.push({ folder: f, title });
        }
    }
    // links: within the folder, plus a link from most notes into Commands (the busy lobe)
    for (const [j, n] of all.entries()) {
      const same = all.filter(x => x.folder === n.folder && x !== n);
      const cmd = all.filter(x => x.folder.startsWith("Commands/"));
      const body = [same[0], same[1], j % 3 ? cmd[j % cmd.length] : null].filter(Boolean).map(x => `[[${x.title}]]`).join(" ");
      await api.createItem({ folder: n.folder, title: n.title, body });
    }
    await window.brain.app.reload();
  });
}

