// Item types. Shape in the graph = type (see icons.js TYPE_SHAPE, graph/shapes.js).
export const TYPES = [
  { id: "note",      name: "Notes",      one: "Note",      dir: "notes" },
  { id: "link",      name: "Links",      one: "Link",      dir: "links" },
  { id: "skill",     name: "Skills",     one: "Skill",     dir: "skills" },
  { id: "hackathon", name: "Hackathons", one: "Hackathon", dir: "hackathons" },
  { id: "project",   name: "Projects",   one: "Project",   dir: "projects" },
];
export const TYPE = Object.fromEntries(TYPES.map(t => [t.id, t]));

// Form schema per type: fields written to frontmatter (the body stays free markdown).
// kind: text | textarea | select | date | number | url | list (comma-separated) | links ([[wikilinks]] to items)
// github: overwritten by GitHub sync (shown read-only); readonly: set by the app.
export const FORMS = {
  note: [],
  link: [
    { key: "url", kind: "url", label: "URL" },
    { key: "site", kind: "text" },
    { key: "summary", kind: "textarea" },
    { key: "status", kind: "text", readonly: true },
    { key: "fetched", kind: "text", readonly: true },
  ],
  skill: [
    { key: "level", kind: "select", options: ["beginner", "intermediate", "advanced"] },
    { key: "since", kind: "text", placeholder: "2025 or 2025-08" },
    { key: "used_in", kind: "links", label: "Used in", linkType: "project" },
  ],
  hackathon: [
    { key: "date", kind: "date" },
    { key: "location", kind: "text" },
    { key: "role", kind: "text", suggestions: ["Participant", "Builder", "Team lead", "Organizer", "Mentor", "Judge"] },
    { key: "team", kind: "list", placeholder: "names, comma-separated" },
    { key: "built", kind: "textarea", label: "What we built" },
    { key: "stack", kind: "list", placeholder: "Rust, Tauri, …" },
    { key: "result", kind: "text", placeholder: "Winner, finalist, …" },
    { key: "repo", kind: "url" },
  ],
  project: [
    { key: "status", kind: "select", options: ["idea", "active", "paused", "shipped", "archived"] },
    { key: "role", kind: "text" },
    { key: "stack", kind: "list" },
    { key: "repo", kind: "url", github: true },
    { key: "description", kind: "textarea", github: true },
    { key: "languages", kind: "list", github: true },
    { key: "topics", kind: "list", github: true },
    { key: "stars", kind: "number", github: true },
    { key: "pushed_at", kind: "text", label: "Last push", github: true },
  ],
};

// Keys the forms know about, per type (other frontmatter keys are still shown).
export const FIELDS = Object.fromEntries(Object.entries(FORMS).map(([t, f]) => [t, f.map(x => x.key)]));
