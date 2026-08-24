const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();

app.enable('trust proxy');

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['*'],
    exposedHeaders: ['Content-Length', 'Content-Type', 'Content-Disposition']
}));

app.use(express.json());

// ============================================================
// إعدادات بوت التلجرام
// ============================================================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8702700536:AAG1StyDb-ciWifPShjyAHnPrixQ_nIc59E'; 
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003947140504'; 
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// ============================================================
// إعداد المجلد المؤقت لتسهيل معالجة Multer
// ============================================================
const uploadDir = path.join('/tmp', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueId = crypto.randomBytes(8).toString('hex');
        const ext = path.extname(file.originalname);
        cb(null, `${Date.now()}-${uniqueId}${ext}`);
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================================
// قاعدة البيانات المؤقتة
// ============================================================
const DB_FILE = path.join('/tmp', 'files-database.json');
let filesDatabase = {};

function loadDatabase() {
    try {
        if (fs.existsSync(DB_FILE)) {
            filesDatabase = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        }
    } catch (e) {
        filesDatabase = {};
    }
}

function saveDatabase() {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(filesDatabase, null, 2));
    } catch (e) {
        console.error('Error saving DB:', e);
    }
}

loadDatabase();

// ============================================================
// 1. رفع الملف إلى تلجرام
// ============================================================
app.post('/api/upload-to-telegram', upload.single('file'), async (req, res) => {
    let localFilePath = null;
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'لم يتم توفير ملف' });
        }

        localFilePath = req.file.path;
        const title = req.body.title || req.file.originalname;
        const originalName = req.file.originalname;
        const fileId = crypto.randomBytes(12).toString('hex');
        const filename = req.file.filename;

        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const permanentLink = `${hostUrl}/files/${filename}`;

        const formData = new FormData();
        formData.append('chat_id', TELEGRAM_CHAT_ID);
        formData.append('document', fs.createReadStream(localFilePath), {
            filename: originalName,
            contentType: req.file.mimetype
        });
        formData.append('caption', `📄 ${title}\n🔗 الرابط: ${permanentLink}`);

        const tgRes = await fetch(`${TELEGRAM_API}/sendDocument`, {
            method: 'POST',
            body: formData,
            headers: formData.getHeaders()
        });

        const tgData = await tgRes.json();

        if (!tgData.ok) {
            throw new Error(tgData.description || 'فشل رفع الملف إلى تلجرام');
        }

        const doc = tgData.result.document;
        const fileInfo = {
            id: fileId,
            title: title,
            originalName: originalName,
            permanentFileName: filename,
            permanentLink: permanentLink,
            fileSize: req.file.size,
            mimeType: req.file.mimetype,
            telegramFileId: doc.file_id,
            telegramFileUniqueId: doc.file_unique_id,
            uploadDate: new Date().toISOString()
        };

        filesDatabase[fileId] = fileInfo;
        filesDatabase[filename] = fileInfo;
        saveDatabase();

        if (fs.existsSync(localFilePath)) {
            fs.unlinkSync(localFilePath);
        }

        return res.json({
            success: true,
            fileId: fileId,
            filename: filename,
            originalName: originalName,
            title: title,
            permanentLink: permanentLink,
            telegramFileId: doc.file_id,
            telegramFileUniqueId: doc.file_unique_id,
            fileSize: req.file.size,
            mimeType: req.file.mimetype
        });

    } catch (err) {
        if (localFilePath && fs.existsSync(localFilePath)) {
            try {
                fs.unlinkSync(localFilePath);
            } catch (e) {}
        }
        console.error('Upload Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ============================================================
// 2. معاينة وتنزيل الملفات
// ============================================================
app.get('/files/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const fileEntry = filesDatabase[filename] || {};

        const telegramFileId = req.query.fileId || fileEntry.telegramFileId;
        const mimeType = req.query.mime || fileEntry.mimeType || 'application/octet-stream';
        const originalName = req.query.name || fileEntry.originalName || filename;
        const fileSize = fileEntry.fileSize || '';

        if (!telegramFileId) {
            return res.status(404).json({ error: 'الملف غير موجود في قاعدة البيانات ولم يتم توفير fileId' });
        }

        const fileUrlResponse = await fetch(`${TELEGRAM_API}/getFile?file_id=${telegramFileId}`);
        const fileUrlData = await fileUrlResponse.json();

        if (!fileUrlData.ok) {
            return res.status(404).json({ error: 'تعذر الوصول إلى الملف عبر تلجرام' });
        }

        const directUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileUrlData.result.file_path}`;
        const tgStream = await fetch(directUrl);

        if (!tgStream.ok) {
            return res.status(502).json({ error: 'فشل استجلاب الملف من خوادم تلجرام' });
        }

        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Length', tgStream.headers.get('content-length') || fileSize);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(originalName)}"`);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Access-Control-Allow-Origin', '*');

        tgStream.body.pipe(res);

        req.on('close', () => {
            if (tgStream.body && typeof tgStream.body.destroy === 'function') {
                tgStream.body.destroy();
            }
        });

    } catch (err) {
        console.error('Proxy Fetch Error:', err);
        if (!res.headersSent) {
            res.status(500).json({ error: 'حدث خطأ في جلب الملف' });
        }
    }
});

// ============================================================
// 3. حذف ملف
// ============================================================
app.delete('/api/files/:fileId', (req, res) => {
    const fileId = req.params.fileId;
    const entry = filesDatabase[fileId];

    if (entry) {
        delete filesDatabase[entry.permanentFileName];
        delete filesDatabase[fileId];
        saveDatabase();
        return res.json({ success: true, message: 'تم حذف الملف بنجاح' });
    }

    res.status(404).json({ error: 'الملف غير موجود' });
});

// ============================================================
// 4. نقطة التحقق (Health Check)
// ============================================================
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        botConnected: !!TELEGRAM_BOT_TOKEN,
        storedFiles: Math.floor(Object.keys(filesDatabase).length / 2),
        timestamp: new Date().toISOString()
    });
});

// ============================================================
// 5. تهيئة Firebase Admin SDK بمتغيرات البيئة حصراً
// ============================================================
// ============================================================
// 5. تهيئة Firebase Admin SDK بمتغيرات البيئة حصراً
// ============================================================
// ============================================================
// 5. تهيئة Firebase Admin SDK بمتغيرات البيئة حصراً
// ============================================================
// ============================================================
// 5. تهيئة Firebase Admin SDK بمتغيرات البيئة حصراً
// ============================================================
let fcmInitialized = false;

try {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    let rawPrivateKey = process.env.FIREBASE_PRIVATE_KEY;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

    let privateKey = null;

    if (rawPrivateKey) {
        // تنظيف العلامات الزائدة
        rawPrivateKey = rawPrivateKey.replace(/^["']|["']$/g, '');

        // التثبت إذا كان المفتاح مشفراً بـ Base64 أو نص عادي
        if (!rawPrivateKey.includes('BEGIN PRIVATE KEY')) {
            privateKey = Buffer.from(rawPrivateKey, 'base64').toString('utf8');
        } else {
            privateKey = rawPrivateKey
                .replace(/\\\\n/g, '\n')
                .replace(/\\n/g, '\n');
        }
    }

    if (projectId && privateKey && clientEmail) {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: projectId,
                privateKey: privateKey,
                clientEmail: clientEmail
            }),
            databaseURL: process.env.FIREBASE_DATABASE_URL || "https://pwa-app-a8e58-default-rtdb.firebaseio.com"
        });
        fcmInitialized = true;
        console.log('✅ Firebase Admin SDK initialized successfully!');
    } else {
        console.warn('⚠️ Firebase Admin SDK: متغيرات البيئة غير مكتملة');
    }
} catch (error) {
    console.error('❌ فشل تهيئة Firebase Admin SDK:', error.message);
}



// ============================================================
// 6. نقاط نهاية الإشعارات
// ============================================================
app.post('/api/send-notification', async (req, res) => {
    try {
        const { tokens, title, body, data } = req.body;
        
        if (!tokens || tokens.length === 0) {
            return res.status(400).json({ error: 'لا توجد توكنات' });
        }
        
        if (!fcmInitialized) {
            return res.status(503).json({ 
                error: 'خدمة الإشعارات غير متاحة حالياً',
                details: 'Firebase Admin SDK لم يتم تهيئته'
            });
        }
        
        const message = {
            notification: {
                title: title || '📢 تحديث جديد',
                body: body || '',
                sound: 'default'
            },
            data: data || {},
            apns: { payload: { aps: { sound: 'default', badge: 1 } } },
            webpush: { headers: { Urgency: 'high' } }
        };
        
        const responses = [];
        for (const token of tokens) {
            try {
                const response = await admin.messaging().send({ ...message, token });
                responses.push({ token, success: true, response });
            } catch (error) {
                responses.push({ token, success: false, error: error.message });
            }
        }
        
        res.json({
            success: true,
            sentCount: responses.filter(r => r.success).length,
            total: tokens.length,
            responses: responses
        });
        
    } catch (error) {
        console.error('خطأ في إرسال الإشعار:', error);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/send-to-all', async (req, res) => {
    try {
        const { title, body, data } = req.body;
        
        if (!fcmInitialized) {
            return res.status(503).json({ 
                error: 'خدمة الإشعارات غير متاحة حالياً',
                details: 'Firebase Admin SDK لم يتم تهيئته'
            });
        }
        
        const snapshot = await admin.database().ref('fcm_tokens').once('value');
        const tokensData = snapshot.val() || {};
        const tokens = Object.values(tokensData).filter(t => t.token).map(t => t.token);
        
        if (tokens.length === 0) {
            return res.status(404).json({ error: 'لا يوجد مستخدمين مسجلين' });
        }
        
        const message = {
            notification: {
                title: title || '📢 تحديث جديد',
                body: body || '',
                sound: 'default'
            },
            data: data || {},
            apns: { payload: { aps: { sound: 'default', badge: 1 } } },
            webpush: { headers: { Urgency: 'high' } }
        };
        
        const responses = [];
        for (const token of tokens) {
            try {
                const response = await admin.messaging().send({ ...message, token });
                responses.push({ token, success: true, response });
            } catch (error) {
                responses.push({ token, success: false, error: error.message });
            }
        }
        
        res.json({
            success: true,
            sentCount: responses.filter(r => r.success).length,
            total: tokens.length,
            responses: responses
        });
        
    } catch (error) {
        console.error('خطأ:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
