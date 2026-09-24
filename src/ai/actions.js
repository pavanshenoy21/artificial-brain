// AI actions on items and editor selections, plus the item context menu.
// All of them are on demand, show a diff first and never write without Accept.

import { app } from "../state.js";
import { api } from "../api.js";
import { openReview } from "./review.js";
import { openMenu } from "../shell/menu.js";
import { FORMS } from "../lib/types.js";
import { toast } from "../shell/toast.js";
import { deleteItem } from "../actions.js";
import { tabsApi } from "../shell/tabs.js";

export const AI_OFF = "Set up an AI provider in Settings to use this";
export const aiOn = () => !!(app.settings?.ai?.provider && app.settings?.ai?.base_url);
const aiReason = () => (aiOn() ? false : AI_OFF);
const providerName = () => app.settings?.ai?.provider === "llama" ? "llama.cpp" : app.settings?.ai?.provider === "groq" ? "Groq" : "the AI provider";
const fillable = n => (FORMS[n.type] || []).some(f => !f.readonly && !f.github);

// Items open in a tab save first, so the diff starts from what's on screen.
async function flush(id) {
  const t = tabsApi.all.find(x => x.kind === "item" && x.id === id);
  await t?.view.save?.();
}

async function apply(id, patch) {
  await api.aiApply(id, patch);
  await app.reload();
}

export async function polishItem(id) {
  await flush(id);
  const n = app.items.get(id);
  if (!n?.body?.trim()) { toast("Nothing to polish: the note is empty"); return; }
  openReview({
    title: `Polish · ${n.title}`,
    working: `Asking ${providerName()}…`,
    load: async () => ({ before: n.body, after: await api.aiPolish(n.body) }),
    onAccept: r => apply(id, { body: r.after }),
  });
}

export async function summarizeItem(id) {
  await flush(id);
  const n = app.items.get(id);
  const text = [n.title, n.body, n.description, n.built].filter(Boolean).join("\n\n");
  if (!text.trim() || text.trim() === n.title) { toast("Nothing to summarise yet"); return; }
  openReview({
    title: `Summarize · ${n.title}`,
    working: `Asking ${providerName()}…`,
    load: async () => ({ rows: [{ key: "summary", before: n.summary ?? "", after: await api.aiSummarize(text) }] }),
    onAccept: r => apply(id, { summary: r.rows[0].after }),
  });
}

export async function fillFormItem(id, text) {
  await flush(id);
  const n = app.items.get(id);
  const src = (text ?? n.body ?? "").trim();
  if (!src) { toast("Write or paste the messy text into the note first, then Fill form"); return; }
  openReview({
    title: `Fill form · ${n.title}`,
    working: `Reading the text with ${providerName()}…`,
    load: async () => {
      const got = await api.aiFillForm(n.type, src);
      return { rows: Object.entries(got).map(([key, after]) => ({ key, before: n[key], after })) };
    },
    onAccept: r => apply(id, Object.fromEntries(r.rows.map(x => [x.key, x.after]))),
  });
}

// Editor selection: the change is applied to the body (so history keeps the original).
export async function selectionAction(kind, tab) {
  const sel = tab.view.selection?.();
  if (!sel?.text.trim()) { toast("Select some text first"); return; }
  await tab.view.save();
  const n = app.items.get(tab.id);
  const body = n.body;
  openReview({
    title: `${kind === "polish" ? "Polish" : "Summarize"} selection · ${n.title}`,
    working: `Asking ${providerName()}…`,
    load: async () => ({ before: sel.text, after: kind === "polish" ? await api.aiPolish(sel.text) : await api.aiSummarize(sel.text) }),
    onAccept: async r => {
      if (app.items.get(tab.id)?.body !== body) throw new Error("The note changed meanwhile; run it again");
      await apply(tab.id, { body: body.slice(0, sel.from) + r.after + body.slice(sel.to) });
    },
  });
}

// Right-click on an item (graph node, file list row, link lists).
export function itemMenu(id, at) {
  const n = app.items.get(id);
  if (!n) return;
  openMenu(at, [
    { label: "Open", iconName: "file", run: () => app.open(id) },
    { label: "Show in graph", iconName: "graph", run: () => { app.emit("show-graph"); app.select(id, { source: "list" }); } },
    "-",
    { label: "Polish", iconName: "edit", disabled: aiReason(), run: () => polishItem(id) },
    { label: "Summarize", iconName: "read", disabled: aiReason(), run: () => summarizeItem(id) },
    { label: "Fill form from text", iconName: "filters", disabled: aiReason() || (fillable(n) ? false : "Only for links, skills, hackathons and projects"), run: () => fillFormItem(id) },
    { label: "Suggest tags and lobe", iconName: "tags", disabled: aiReason(), run: () => { app.select(id, { source: "list" }); app.emit("suggest", id); } },
    "-",
    { label: "Delete", iconName: "trash", run: () => deleteItem(id) },
  ]);
}

// Right-click inside the editor.
export function editorMenu(tab, at) {
  const sel = tab.view.selection?.();
  const has = !!sel?.text.trim();
  const n = app.items.get(tab.id);
  openMenu(at, [
    { label: "Polish selection", iconName: "edit", disabled: aiReason() || (has ? false : "Select some text first"), run: () => selectionAction("polish", tab) },
    { label: "Summarize selection", iconName: "read", disabled: aiReason() || (has ? false : "Select some text first"), run: () => selectionAction("summarize", tab) },
    { label: "Fill form from selection", iconName: "filters", disabled: aiReason() || (!has ? "Select some text first" : fillable(n) ? false : "Only for links, skills, hackathons and projects"), run: () => fillFormItem(tab.id, sel.text) },
    "-",
    { label: "Polish whole note", iconName: "edit", disabled: aiReason(), run: () => polishItem(tab.id) },
    { label: "Summarize note", iconName: "read", disabled: aiReason(), run: () => summarizeItem(tab.id) },
  ]);
}
