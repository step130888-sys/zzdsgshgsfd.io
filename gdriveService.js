const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CONFIG_PATH = path.join(__dirname, 'gdrive_config.json');
const DEFAULT_FOLDER_ID = '1hfpxSnI4AtbHV9MPtnEkIVAoII1VP0g7';
const DEFAULT_FOLDER_URL = `https://drive.google.com/drive/folders/${DEFAULT_FOLDER_ID}`;
const SERVICE_ACCOUNT_FILE = path.join(__dirname, 'service_account.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

function getGdriveConfig() {
  const config = {
    folder_id: DEFAULT_FOLDER_ID,
    folder_url: DEFAULT_FOLDER_URL,
    service_account_file: 'service_account.json',
    webhook_url: ''
  };
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      Object.assign(config, saved);
    } catch (e) {
      console.error('Error reading gdrive_config.json:', e);
    }
  }
  return config;
}

function saveGdriveConfig(updates) {
  const current = getGdriveConfig();
  Object.assign(current, updates);
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
  } catch (e) {
    console.error('Error saving gdrive_config.json:', e);
  }
}

function getTargetFolderId() {
  return getGdriveConfig().folder_id || DEFAULT_FOLDER_ID;
}

function getTargetFolderUrl() {
  const cfg = getGdriveConfig();
  return cfg.folder_url || `https://drive.google.com/drive/folders/${cfg.folder_id || DEFAULT_FOLDER_ID}`;
}

function getServiceAccountInfo() {
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    try {
      const sa = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_FILE, 'utf8'));
      return {
        configured: true,
        client_email: sa.client_email || 'Service Account',
        project_id: sa.project_id || ''
      };
    } catch (e) {
      return { configured: false, error: e.message };
    }
  }
  return { configured: false };
}

function sanitizeFilename(filename) {
  return filename.replace(/[^a-zA-Z0-9._\-а-яА-ЯёЁ]/g, '_');
}

async function uploadToGdriveServiceAccount(filePath, fileName, mimeType = 'application/octet-stream') {
  if (!fs.existsSync(SERVICE_ACCOUNT_FILE)) return null;
  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: SERVICE_ACCOUNT_FILE,
      scopes: ['https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/drive']
    });
    const drive = google.drive({ version: 'v3', auth });
    const folderId = getTargetFolderId();

    const fileMetadata = {
      name: fileName,
      parents: [folderId]
    };
    const media = {
      mimeType,
      body: fs.createReadStream(filePath)
    };

    const res = await drive.files.create({
      resource: fileMetadata,
      media,
      fields: 'id, name, webViewLink, webContentLink'
    });

    return {
      file_id: res.data.id,
      web_link: res.data.webViewLink,
      direct_link: res.data.webContentLink
    };
  } catch (e) {
    console.error('Error uploading to Google Drive via Service Account:', e);
    return null;
  }
}

async function uploadToGdriveWebhook(fileBuffer, fileName, mimeType = 'application/octet-stream') {
  const cfg = getGdriveConfig();
  if (!cfg.webhook_url) return null;
  try {
    const base64Data = fileBuffer.toString('base64');
    const payload = {
      filename: fileName,
      mimeType,
      fileData: base64Data,
      folderId: getTargetFolderId()
    };
    const response = await fetch(cfg.webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (response.ok) {
      return await response.json();
    }
  } catch (e) {
    console.error('Error uploading via Google Apps Script Webhook:', e);
  }
  return null;
}

async function saveLocalAndSyncGdrive(fileBuffer, originalFilename, taskId = 0) {
  const cleanName = sanitizeFilename(originalFilename);
  const uniqueName = `task_${taskId}_${Date.now()}_${cleanName}`;
  const localPath = path.join(UPLOADS_DIR, uniqueName);

  fs.writeFileSync(localPath, fileBuffer);
  const localUrl = `/uploads/${uniqueName}`;

  let gdriveRes = null;
  // 1. Try Service Account
  if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
    gdriveRes = await uploadToGdriveServiceAccount(localPath, `${taskId}_${cleanName}`);
  }
  // 2. Try Webhook if Service Account didn't return link
  if (!gdriveRes) {
    gdriveRes = await uploadToGdriveWebhook(fileBuffer, `${taskId}_${cleanName}`);
  }

  const finalLink = (gdriveRes && gdriveRes.web_link) ? gdriveRes.web_link : localUrl;
  return {
    fileLink: finalLink,
    fileName: cleanName,
    gdriveRes
  };
}

function getAppsScriptTemplate() {
  const folderId = getTargetFolderId();
  return `function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);
    var folderId = data.folderId || "${folderId}";
    var folder = DriveApp.getFolderById(folderId);
    
    var decoded = Utilities.base64Decode(data.fileData);
    var blob = Utilities.newBlob(decoded, data.mimeType, data.filename);
    var file = folder.createFile(blob);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      file_id: file.getId(),
      web_link: file.getUrl(),
      name: file.getName()
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}`;
}

async function syncAllPendingTasks(db) {
  const pending = await db.all('SELECT * FROM tasks WHERE file_link LIKE "/uploads/%"');
  let synced = 0;
  for (const task of pending) {
    const localRel = task.file_link.replace(/^\//, '');
    const localPath = path.join(__dirname, localRel);
    if (fs.existsSync(localPath)) {
      const buffer = fs.readFileSync(localPath);
      let res = null;
      if (fs.existsSync(SERVICE_ACCOUNT_FILE)) {
        res = await uploadToGdriveServiceAccount(localPath, task.file_name || path.basename(localPath));
      }
      if (!res) {
        res = await uploadToGdriveWebhook(buffer, task.file_name || path.basename(localPath));
      }
      if (res && res.web_link) {
        await db.run('UPDATE tasks SET file_link = ? WHERE id = ?', [res.web_link, task.id]);
        synced++;
      }
    }
  }
  return synced;
}

module.exports = {
  getGdriveConfig,
  saveGdriveConfig,
  getTargetFolderId,
  getTargetFolderUrl,
  getServiceAccountInfo,
  saveLocalAndSyncGdrive,
  uploadToGdriveServiceAccount,
  uploadToGdriveWebhook,
  getAppsScriptTemplate,
  syncAllPendingTasks,
  SERVICE_ACCOUNT_FILE,
  UPLOADS_DIR
};
