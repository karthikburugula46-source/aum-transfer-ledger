// Paste into Extensions > Apps Script on the Google Sheet, then add an
// installable "On edit" trigger (Triggers > + Add Trigger > onSheetEdit > On edit).
// Set GITHUB_TOKEN in Project Settings > Script Properties (a fine-grained PAT
// scoped only to this repo, with Actions: Read and write permission).

const GITHUB_OWNER = 'REPLACE_WITH_GITHUB_USERNAME';
const GITHUB_REPO = 'aum-transfer-ledger';

function onSheetEdit(e) {
  const token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  if (!token) {
    Logger.log('GITHUB_TOKEN script property is not set.');
    return;
  }
  const url = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/sync.yml/dispatches`;
  UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
    payload: JSON.stringify({ ref: 'main' }),
    muteHttpExceptions: true,
  });
}
