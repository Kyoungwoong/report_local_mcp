import { App } from '@modelcontextprotocol/ext-apps';
import {
  createApprovalArguments,
  createUpdateArguments,
  isRecord,
  isVersionConflict,
  parsePayload,
  type Draft,
  type DraftPayload,
} from './model.js';

const app = new App({ name: 'local-devlog-daily-draft', version: '0.2.0' });
let current: DraftPayload | undefined;

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}

function setStatus(message: string, kind: 'normal' | 'error' | 'success' = 'normal'): void {
  const status = element<HTMLDivElement>('status');
  status.textContent = message;
  status.className = kind === 'normal' ? 'hint' : kind;
}

function renderList(drafts: Draft[]): void {
  const panel = element<HTMLElement>('list-panel');
  const list = element<HTMLDivElement>('draft-list');
  list.replaceChildren();
  panel.hidden = false;
  for (const draft of drafts) {
    const button = document.createElement('button');
    button.className = 'draft-row';
    button.textContent = `${draft.workDate} · ${draft.status} · v${draft.version}`;
    button.addEventListener('click', () => void callTool('get_daily_draft', { draftId: draft.draftId }));
    list.append(button);
  }
  if (drafts.length === 0) list.textContent = 'No drafts yet.';
}

function renderDraft(payload: DraftPayload): void {
  current = payload;
  const { draft, revisions } = payload;
  element<HTMLElement>('editor-panel').hidden = false;
  element<HTMLDivElement>('draft-meta').textContent = `${draft.workDate} · ${draft.timezone} · ${draft.status} · version ${draft.version}`;
  element<HTMLDivElement>('warnings').textContent = draft.approvalWarnings.join(', ');
  element<HTMLTextAreaElement>('summary').value = draft.summary;
  element<HTMLTextAreaElement>('next-actions').value = draft.nextActions.join('\n');
  element<HTMLTextAreaElement>('work-items').value = JSON.stringify(draft.workItems, null, 2);
  element<HTMLInputElement>('confirmation').value = '';
  element<HTMLDivElement>('history').textContent = revisions
    .map((revision) => `v${revision.version} ${revision.status} · ${revision.updatedAt}`)
    .join('\n');

  const approved = draft.status === 'APPROVED';
  element<HTMLButtonElement>('save').disabled = approved;
  element<HTMLButtonElement>('reject').disabled = approved || draft.status === 'REJECTED';
  element<HTMLButtonElement>('reopen').disabled = approved || draft.status === 'PENDING';
  element<HTMLButtonElement>('approve').disabled = approved || draft.status === 'REJECTED';
}

function renderResult(value: unknown, isError = false): void {
  if (isError) {
    const message = isRecord(value) && typeof value.message === 'string' ? value.message : 'The tool call failed.';
    setStatus(message, 'error');
    if (isVersionConflict(value) && current) {
      void callTool('get_daily_draft', { draftId: current.draft.draftId });
    }
    return;
  }
  const payload = parsePayload(value);
  if (!payload) {
    setStatus('Received an unsupported tool response.', 'error');
    return;
  }
  if ('drafts' in payload) renderList(payload.drafts);
  else renderDraft(payload);
  setStatus('Ready', 'success');
}

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  setStatus(`Running ${name}…`);
  try {
    const result = await app.callServerTool({ name, arguments: args });
    renderResult(result.structuredContent, result.isError === true);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Tool transport failed.', 'error');
  }
}

function editedInput(status: 'PENDING' | 'REJECTED'): Record<string, unknown> {
  if (!current) throw new Error('No draft is loaded');
  const workItems = JSON.parse(element<HTMLTextAreaElement>('work-items').value) as unknown;
  if (!Array.isArray(workItems)) throw new Error('Work items must be a JSON array');
  return createUpdateArguments(current.draft, {
    summary: element<HTMLTextAreaElement>('summary').value,
    workItems,
    nextActions: element<HTMLTextAreaElement>('next-actions').value.split('\n').map((value) => value.trim()).filter(Boolean),
  }, status);
}

element<HTMLButtonElement>('save').addEventListener('click', () => {
  try { void callTool('update_daily_draft', editedInput('PENDING')); } catch (error) { setStatus(String(error), 'error'); }
});
element<HTMLButtonElement>('reject').addEventListener('click', () => {
  try { void callTool('update_daily_draft', editedInput('REJECTED')); } catch (error) { setStatus(String(error), 'error'); }
});
element<HTMLButtonElement>('reopen').addEventListener('click', () => {
  try { void callTool('update_daily_draft', editedInput('PENDING')); } catch (error) { setStatus(String(error), 'error'); }
});
element<HTMLButtonElement>('refresh').addEventListener('click', () => {
  if (current) void callTool('get_daily_draft', { draftId: current.draft.draftId });
});
element<HTMLButtonElement>('approve').addEventListener('click', () => {
  if (!current) return;
  void callTool('approve_daily_draft', createApprovalArguments(
    current.draft,
    element<HTMLInputElement>('confirmation').value || undefined,
  ));
});

app.addEventListener('toolresult', (result) => renderResult(result.structuredContent, result.isError === true));
await app.connect();
setStatus('Ready', 'success');

