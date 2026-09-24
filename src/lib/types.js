// Item types. Shape in the graph = type (see icons.js TYPE_SHAPE, graph/shapes.js).
export const TYPES = [
  { id: "note",      name: "Notes",      one: "Note",      dir: "notes" },
  { id: "link",      name: "Links",      one: "Link",      dir: "links" },
  { id: "skill",     name: "Skills",     one: "Skill",     dir: "skills" },
  { id: "hackathon", name: "Hackathons", one: "Hackathon", dir: "hackathons" },
  { id: "project",   name: "Projects",   one: "Project",   dir: "projects" },
];
export const TYPE = Object.fromEntries(TYPES.map(t => [t.id, t]));

// Fields shown in the properties pane, per type (forms come in milestone 7).
export const FIELDS = {
  note: [],
  link: ["url", "site", "summary", "fetched", "status"],
  skill: ["level", "since", "used_in"],
  hackathon: ["date", "location", "role", "team", "built", "stack", "result", "repo"],
  project: ["repo", "description", "languages", "topics", "stars", "pushed_at", "status", "role", "stack"],
};
