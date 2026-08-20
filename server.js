const express = require('express');
const multer = require('multer');
const FormData = require('form-data');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const { Readable } = require('stream'); // تم إضافة مكتبة Stream للتحويل

const app = express();





// ============================================================
// تمكين trust proxy للتعرف على بروتوكول HTTPS في بيئات Cloud مثل Render
// ============================================================
app.enable('trust proxy');

// ============================================================
// إعداد CORS بمرونة لتجاوز القيود في بيئة iOS/PWA
// ============================================================
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
// إعداد المجلد المؤقت لتسهيل معالجة Multer قبل الرفع
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
    limits: { fileSize: 50 * 1024 * 1024 } // حد أقصى 50MB
});

// ============================================================
// قاعدة البيانات المؤقتة (ذاكرة مع مساندة ملفية)
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
// 1. رفع الملف إلى تلجرام وتخزين البيانات
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

        // توليد رابط ممرر عبر البروتوكول الآمن
        const hostUrl = `${req.protocol}://${req.get('host')}`;
        const permanentLink = `${hostUrl}/files/${filename}`;

        // رفع الملف كـ Stream إلى قناة/شات تلجرام
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
        filesDatabase[filename] = fileInfo; // الربط بالاسم والـ ID معاً
        saveDatabase();

        // تنظيف الملف المؤقت فور الانتهاء
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
// 2. معاينة وتنزيل الملفات المرفوعة من تلجرام (Proxy Stream)
// ============================================================
app.get('/files/:filename', async (req, res) => {
    try {
        const filename = req.params.filename;
        const fileEntry = filesDatabase[filename];

        if (!fileEntry || !fileEntry.telegramFileId) {
            return res.status(404).json({ error: 'الملف غير موجود في قاعدة البيانات' });
        }

        // جلب مسار الملف المباشر من API التلجرام
        const fileUrlResponse = await fetch(`${TELEGRAM_API}/getFile?file_id=${fileEntry.telegramFileId}`);
        const fileUrlData = await fileUrlResponse.json();

        if (!fileUrlData.ok) {
            return res.status(404).json({ error: 'تعذر الوصول إلى الملف عبر تلجرام' });
        }

        const directUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileUrlData.result.file_path}`;
        const tgStream = await fetch(directUrl);

        if (!tgStream.ok) {
            return res.status(502).json({ error: 'فشل استجلاب الملف من خوادم تلجرام' });
        }

        // ضبط الترويسات بالكامل لتسهيل المعاينة والتنزيل محلياً على iOS/IndexedDB
        res.setHeader('Content-Type', fileEntry.mimeType || 'application/octet-stream');
        res.setHeader('Content-Length', tgStream.headers.get('content-length') || fileEntry.fileSize);
        res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileEntry.originalName)}"`);
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        res.setHeader('Access-Control-Allow-Origin', '*');

        // تحويل Web Stream إلى Node Stream لمنع الانهيار (Crash)
        Readable.fromWeb(tgStream.body).pipe(res);

        // إلغاء الـ Stream بأمان عند إغلاق العميل للاتصال
        req.on('close', () => {
            if (tgStream.body && typeof tgStream.body.cancel === 'function') {
                tgStream.body.cancel();
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
// 3. حذف ملف من قاعدة البيانات
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
