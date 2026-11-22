import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express, { Request, Response, NextFunction } from 'express';
import { put, get, list } from '@vercel/blob';
import {
  VIETNAM_BARCODE_CATALOG,
  GS1_BRAND_PREFIXES,
} from '../data/vietnamBarcodes.js';

const BLOB_PATHNAME = 'taphoadungcanh-blob/database.json';
const LOCAL_FALLBACK_FILE = path.resolve(
  process.cwd(),
  '.taphoadungcanh-blob-local.json'
);

// Ephemeral in-memory signing secret (or from process.env) for Bearer session tokens
const SESSION_SIGNING_KEY = process.env.SESSION_SECRET
  ? crypto.createHash('sha256').update(process.env.SESSION_SECRET).digest()
  : crypto.randomBytes(32);

export interface BlobProductRecord {
  id: string;
  barcode: string;
  name: string;
  category: string;
  unit: string;
  price: number;
  costPrice: number;
  stock: number;
  source: string;
  updatedAtIso: string;
}

export interface BlobInvoiceRecord {
  id: string;
  invoiceCode: string;
  tabName: string;
  customerName: string;
  itemsJson: string;
  itemCount: number;
  subtotal: number;
  discount: number;
  totalAmount: number;
  amountTendered: number;
  changeDue: number;
  paperWidth: '58mm' | '80mm';
  createdAtIso: string;
}

export interface BlobStoreProfile {
  storeName: string;
  address: string;
  phone: string;
  footerNote: string;
  paperWidth: '58mm' | '80mm';
  bankBin: string;
  bankShortName: string;
  bankAccountNumber: string;
  bankAccountName: string;
  bankQrNoteTemplate: string;
  customQrDataUrl?: string;
}

interface EncryptedAdminCredential {
  iv: string;
  authTag: string;
  ciphertext: string;
}

export interface BlobOrderTabLineItem {
  lineId: string;
  productId?: string;
  barcode: string;
  name: string;
  unit: string;
  price: number;
  quantity: number;
  note?: string;
}

export interface BlobPosOrderTab {
  id: string;
  tabNumber: number;
  label: string;
  customerName: string;
  createdAtIso: string;
  items: BlobOrderTabLineItem[];
  discount: number;
  amountTendered: number;
  savedInvoiceId?: string;
  savedInvoiceCode?: string;
}

export interface TapHoaBlobDatabase {
  version: number;
  storeId: string;
  updatedAtIso: string;
  adminCredential?: EncryptedAdminCredential | null;
  storeProfile: BlobStoreProfile;
  products: Record<string, BlobProductRecord>;
  deletedBarcodes: Record<string, boolean>;
  invoices: BlobInvoiceRecord[];
  orderTabs?: BlobPosOrderTab[];
  activeTabId?: string;
  currentInvoiceCode?: string;
}

const DEFAULT_STORE_PROFILE: BlobStoreProfile = {
  storeName: 'TẠP HÓA DUNG CẢNH',
  address: 'Khu dân cư trung tâm · Chuyên sỉ & lẻ tạp hóa',
  phone: '0905 888 999',
  footerNote: 'Cảm ơn Quý Khách · Hẹn gặp lại!',
  paperWidth: '80mm',
  bankBin: '970436',
  bankShortName: 'VCB',
  bankAccountNumber: '0123456789',
  bankAccountName: 'TAP HOA DUNG CANH',
  bankQrNoteTemplate: 'TT',
  customQrDataUrl: '',
};

function createEmptyDatabase(): TapHoaBlobDatabase {
  return {
    version: 1,
    storeId: process.env.BLOB_STORE_ID || 'taphoadungcanh-blob',
    updatedAtIso: new Date().toISOString(),
    adminCredential: null,
    storeProfile: { ...DEFAULT_STORE_PROFILE },
    products: {},
    deletedBarcodes: {},
    invoices: [],
    orderTabs: [],
    activeTabId: '',
    currentInvoiceCode: '',
  };
}

// In-memory cache to avoid redundant network hops on every read
let cachedDb: TapHoaBlobDatabase | null = null;
let lastBlobFetchMs = 0;

function getEncryptionKey(): Buffer {
  const secretSeed =
    process.env.BLOB_READ_WRITE_TOKEN ||
    process.env.BLOB_STORE_ID ||
    'taphoadungcanh-default-key-seed';
  return crypto.createHash('sha256').update(secretSeed).digest();
}

function encryptCredentialPayload(payload: {
  salt: string;
  hash: string;
}): EncryptedAdminCredential {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = JSON.stringify(payload);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    ciphertext: encrypted.toString('hex'),
  };
}

function decryptCredentialPayload(
  enc: EncryptedAdminCredential
): { salt: string; hash: string } | null {
  try {
    const key = getEncryptionKey();
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      key,
      Buffer.from(enc.iv, 'hex')
    );
    decipher.setAuthTag(Buffer.from(enc.authTag, 'hex'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(enc.ciphertext, 'hex')),
      decipher.final(),
    ]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch {
    return null;
  }
}

function getBlobToken(): string {
  const token = (process.env.BLOB_READ_WRITE_TOKEN || '').trim();
  if (!token || token === 'MY_BLOB_TOKEN') return '';
  return token;
}

async function readStreamToString(
  stream: ReadableStream<Uint8Array>
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

async function putBlobWithPrivateFirst(
  pathname: string,
  body: string,
  token: string
) {
  try {
    return await put(pathname, body, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/json',
      token,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fallback if store is configured as public-only
    if (msg.toLowerCase().includes('public')) {
      return await put(pathname, body, {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/json',
        token,
      });
    }
    throw err;
  }
}

async function loadBlobDatabase(
  forceRefresh = false
): Promise<TapHoaBlobDatabase> {
  const token = getBlobToken();
  const now = Date.now();

  if (cachedDb && !forceRefresh && now - lastBlobFetchMs < 4000) {
    return cachedDb;
  }

  // 1. Try reading from Private Vercel Blob Store (taphoadungcanh-blob/database.json) via get(..., { access: 'private' })
  if (token) {
    try {
      let rawText: string | null = null;

      try {
        const privateRes = await get(BLOB_PATHNAME, {
          access: 'private',
          useCache: false,
          token,
        });
        if (
          privateRes &&
          privateRes.statusCode === 200 &&
          privateRes.stream
        ) {
          rawText = await readStreamToString(privateRes.stream);
        }
      } catch {
        // Fallback to list + get in case pathname has a suffix or public access
        const { blobs } = await list({
          prefix: BLOB_PATHNAME,
          token,
          limit: 5,
        });
        if (blobs && blobs.length > 0) {
          const sorted = [...blobs].sort(
            (a, b) =>
              new Date(b.uploadedAt).getTime() -
              new Date(a.uploadedAt).getTime()
          );
          const latestBlob = sorted[0];
          const byUrl = await get(latestBlob.url, {
            access: 'private',
            useCache: false,
            token,
          }).catch(() =>
            get(latestBlob.url, {
              access: 'public',
              useCache: false,
              token,
            })
          );
          if (byUrl && byUrl.statusCode === 200 && byUrl.stream) {
            rawText = await readStreamToString(byUrl.stream);
          }
        }
      }

      if (rawText) {
        const parsed = JSON.parse(rawText) as Partial<TapHoaBlobDatabase>;
        cachedDb = {
          ...createEmptyDatabase(),
          ...parsed,
          storeProfile: {
            ...DEFAULT_STORE_PROFILE,
            ...(parsed.storeProfile || {}),
          },
          products: parsed.products || {},
          deletedBarcodes: parsed.deletedBarcodes || {},
          invoices: Array.isArray(parsed.invoices) ? parsed.invoices : [],
        };
        lastBlobFetchMs = now;
        return cachedDb;
      }
    } catch (err) {
      console.error(
        'Vercel Blob read notice:',
        err instanceof Error ? err.message : err
      );
    }
  }

  // 2. Fallback to local file snapshot if Blob Store is empty or token not configured yet
  try {
    if (fs.existsSync(LOCAL_FALLBACK_FILE)) {
      const raw = fs.readFileSync(LOCAL_FALLBACK_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<TapHoaBlobDatabase>;
      cachedDb = {
        ...createEmptyDatabase(),
        ...parsed,
        storeProfile: {
          ...DEFAULT_STORE_PROFILE,
          ...(parsed.storeProfile || {}),
        },
        products: parsed.products || {},
        deletedBarcodes: parsed.deletedBarcodes || {},
        invoices: Array.isArray(parsed.invoices) ? parsed.invoices : [],
      };
      lastBlobFetchMs = now;
      return cachedDb;
    }
  } catch {
    // Ignore local file read errors
  }

  cachedDb = createEmptyDatabase();
  lastBlobFetchMs = now;
  return cachedDb;
}

function pruneUnmodifiedDefaultCatalogDuplicates(
  products: Record<string, BlobProductRecord>
): Record<string, BlobProductRecord> {
  const cleaned: Record<string, BlobProductRecord> = {};
  for (const [code, prod] of Object.entries(products || {})) {
    const base = VIETNAM_BARCODE_CATALOG[code];
    if (
      base &&
      prod.source === 'catalog_vn_9000' &&
      prod.name === base.name &&
      prod.price === base.suggestedPrice &&
      prod.costPrice === base.suggestedCostPrice &&
      prod.unit === base.unit &&
      prod.category === base.category
    ) {
      // Unmodified built-in catalog item is already included in VIETNAM_MASTER_PRODUCTS_LIST
      continue;
    }
    cleaned[code] = prod;
  }
  return cleaned;
}

async function saveBlobDatabase(dbData: TapHoaBlobDatabase): Promise<{
  savedToVercelBlob: boolean;
  blobUrl?: string;
}> {
  dbData.updatedAtIso = new Date().toISOString();
  dbData.storeId = process.env.BLOB_STORE_ID || 'taphoadungcanh-blob';
  dbData.products = pruneUnmodifiedDefaultCatalogDuplicates(dbData.products);
  cachedDb = dbData;
  lastBlobFetchMs = Date.now();

  const serialized = JSON.stringify(dbData, null, 2);

  // Save local snapshot for resilience in dev preview
  try {
    fs.writeFileSync(LOCAL_FALLBACK_FILE, serialized, 'utf8');
  } catch {
    // Ignore read-only filesystem on serverless
  }

  const token = getBlobToken();
  if (token) {
    const blobResult = await putBlobWithPrivateFirst(
      BLOB_PATHNAME,
      serialized,
      token
    );
    return {
      savedToVercelBlob: true,
      blobUrl: blobResult.url,
    };
  }

  return { savedToVercelBlob: false };
}

// HMAC-SHA256 Bearer Session Token Helpers
function issueSessionToken(subject: string): string {
  const exp = Date.now() + 1000 * 60 * 60 * 12; // 12 hours
  const payload = Buffer.from(JSON.stringify({ sub: subject, exp })).toString(
    'base64url'
  );
  const sig = crypto
    .createHmac('sha256', SESSION_SIGNING_KEY)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

function verifySessionToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expectedSig = crypto
    .createHmac('sha256', SESSION_SIGNING_KEY)
    .update(payload)
    .digest('base64url');

  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expBuf.length) return false;
  if (!crypto.timingSafeEqual(sigBuf, expBuf)) return false;

  try {
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8')
    ) as { exp?: number };
    return Boolean(decoded.exp && decoded.exp > Date.now());
  } catch {
    return false;
  }
}

function requireAuth(_req: Request, _res: Response, next: NextFunction) {
  // Single shared store database (taphoadungcanh-blob) without password prompt as requested
  next();
}

// Barcode Registry Helpers
interface OpenFactsProductResponse {
  status?: number;
  product?: {
    product_name_vi?: string;
    product_name?: string;
    generic_name_vi?: string;
    generic_name?: string;
    brands?: string;
    quantity?: string;
    categories?: string;
  };
}

function inferCategoryAndUnit(rawName: string, rawCategories: string): {
  category: string;
  unit: string;
  suggestedPrice: number;
} {
  const combined = `${rawName} ${rawCategories}`.toLowerCase();

  let category = 'Hàng tạp hóa khác';
  if (/(mì|phở|bún|miến|cháo|xúc xích|gạo|đồ hộp)/.test(combined)) {
    category = 'Mì & Thực phẩm khô';
  } else if (/(bia|beer|rượu|cider|heineken|tiger|saigon|sabeco)/.test(combined)) {
    category = 'Bia & Đồ uống có cồn';
  } else if (/(sữa|milk|yogurt|sữa chua|ông thọ|vinamilk|yakult|phô mai)/.test(combined)) {
    category = 'Sữa & Chế phẩm sữa';
  } else if (/(nước ngọt|nước khoáng|trà|cà phê|coffee|tea|soda|cola|pepsi|nước tăng lực|beverage|drink|juice)/.test(combined)) {
    category = 'Đồ uống & Giải khát';
  } else if (/(nước mắm|nước tương|tương ớt|dầu ăn|bột ngọt|hạt nêm|muối|đường|gia vị|sauce|oil)/.test(combined)) {
    category = 'Gia vị & Dầu ăn';
  } else if (/(bánh|kẹo|snack|chocolate|chocopie|cookie|biscuit|chip)/.test(combined)) {
    category = 'Bánh kẹo & Ăn vặt';
  } else if (/(bột giặt|nước rửa|kem đánh răng|dầu gội|xà phòng|khăn giấy|shampoo|soap|detergent)/.test(combined)) {
    category = 'Hóa mỹ phẩm & Gia dụng';
  }

  let unit = 'Cái';
  let suggestedPrice = 15000;

  if (/(thùng|24 lon|30 gói|24 chai)/.test(combined)) {
    unit = 'Thùng';
    suggestedPrice = 150000;
  } else if (/(lốc|4 hộp|6 lon)/.test(combined)) {
    unit = 'Lốc';
    suggestedPrice = 33000;
  } else if (/(lon|can|320ml|330ml|250ml)/.test(combined)) {
    unit = 'Lon';
    suggestedPrice = 12000;
  } else if (/(chai|bottle|500ml|1l|1\.5l|900ml|750g)/.test(combined)) {
    unit = 'Chai';
    suggestedPrice = 22000;
  } else if (/(hộp|box)/.test(combined)) {
    unit = 'Hộp';
    suggestedPrice = 45000;
  } else if (/(tuýp|tube)/.test(combined)) {
    unit = 'Tuýp';
    suggestedPrice = 28000;
  } else if (/(túi|bịch|pouch)/.test(combined)) {
    unit = 'Túi';
    suggestedPrice = 35000;
  } else if (/(gói|pack|75g|65g)/.test(combined)) {
    unit = 'Gói';
    suggestedPrice = 6000;
  }

  return { category, unit, suggestedPrice };
}

async function queryOpenFactsRegistry(
  domain: string,
  barcode: string
): Promise<{ name: string; categories: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(
      `https://${domain}/api/v2/product/${encodeURIComponent(barcode)}.json`,
      {
        signal: controller.signal,
        headers: { 'User-Agent': 'TapHoaDungCanhPOS/1.0' },
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as OpenFactsProductResponse;
    if (data.status === 1 && data.product) {
      const p = data.product;
      const baseName =
        p.product_name_vi ||
        p.product_name ||
        p.generic_name_vi ||
        p.generic_name ||
        '';
      if (!baseName) return null;

      const brand = p.brands ? p.brands.split(',')[0].trim() : '';
      const qty = p.quantity ? p.quantity.trim() : '';

      const parts = [baseName.trim()];
      if (brand && !baseName.toLowerCase().includes(brand.toLowerCase())) {
        parts.push(brand);
      }
      if (qty && !baseName.toLowerCase().includes(qty.toLowerCase())) {
        parts.push(qty);
      }

      return {
        name: parts.join(' - ').slice(0, 180),
        categories: p.categories || '',
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export function createApiRouter() {
  const router = express.Router();
  router.use(express.json({ limit: '15mb' }));

  // 1. Auth & Blob Store Connection Status
  router.get('/api/auth/status', async (_req, res) => {
    try {
      const dbData = await loadBlobDatabase();
      const envPasscodeSet = Boolean(
        process.env.STORE_ADMIN_PASSCODE &&
          process.env.STORE_ADMIN_PASSCODE.trim()
      );
      const isClaimed = envPasscodeSet || Boolean(dbData.adminCredential);
      return res.json({
        isClaimed,
        envPasscodeSet,
        blobConnected: Boolean(getBlobToken()),
        blobStoreName: 'taphoadungcanh-blob',
        blobStoreId: process.env.BLOB_STORE_ID || 'taphoadungcanh-blob',
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi kiểm tra trạng thái Blob Store.',
      });
    }
  });

  // 2. First-run Store Owner Password Claim Route (Locks permanently once claimed)
  router.post('/api/auth/claim', async (req, res) => {
    try {
      const envPasscode = (process.env.STORE_ADMIN_PASSCODE || '').trim();
      const dbData = await loadBlobDatabase(true);

      if (envPasscode || dbData.adminCredential) {
        return res.status(403).json({
          error:
            'Mật khẩu cửa hàng đã được thiết lập. Vui lòng sử dụng chức năng Đăng nhập.',
        });
      }

      const rawPasscode = String(req.body?.passcode || '').trim();
      if (rawPasscode.length < 4 || rawPasscode.length > 128) {
        return res.status(400).json({
          error: 'Mật khẩu quản lý cửa hàng phải từ 4 đến 128 ký tự.',
        });
      }

      const salt = crypto.randomBytes(16).toString('hex');
      const derivedHash = crypto
        .scryptSync(rawPasscode, salt, 64)
        .toString('hex');

      dbData.adminCredential = encryptCredentialPayload({
        salt,
        hash: derivedHash,
      });

      const saveRes = await saveBlobDatabase(dbData);
      const token = issueSessionToken('store_owner');

      return res.json({
        token,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Không thể thiết lập mật khẩu cửa hàng.',
      });
    }
  });

  // 3. Store Owner Login Route
  router.post('/api/auth/login', async (req, res) => {
    try {
      const rawPasscode = String(req.body?.passcode || '').trim();
      if (!rawPasscode) {
        return res.status(400).json({ error: 'Vui lòng nhập mật khẩu cửa hàng.' });
      }

      const envPasscode = (process.env.STORE_ADMIN_PASSCODE || '').trim();
      if (envPasscode) {
        const inputDigest = crypto
          .createHash('sha256')
          .update(rawPasscode)
          .digest();
        const envDigest = crypto
          .createHash('sha256')
          .update(envPasscode)
          .digest();
        if (!crypto.timingSafeEqual(inputDigest, envDigest)) {
          return res
            .status(401)
            .json({ error: 'Mật khẩu quản lý cửa hàng không chính xác.' });
        }
        return res.json({ token: issueSessionToken('store_owner') });
      }

      const dbData = await loadBlobDatabase();
      if (!dbData.adminCredential) {
        return res.status(400).json({
          error: 'Cửa hàng chưa tạo mật khẩu lần đầu. Vui lòng tạo mật khẩu mới.',
        });
      }

      const cred = decryptCredentialPayload(dbData.adminCredential);
      if (!cred) {
        return res.status(500).json({
          error: 'Không thể giải mã thông tin xác thực trong Blob Store.',
        });
      }

      const candidateHash = crypto.scryptSync(rawPasscode, cred.salt, 64);
      const storedHash = Buffer.from(cred.hash, 'hex');
      if (
        candidateHash.length !== storedHash.length ||
        !crypto.timingSafeEqual(candidateHash, storedHash)
      ) {
        return res
          .status(401)
          .json({ error: 'Mật khẩu quản lý cửa hàng không chính xác.' });
      }

      return res.json({ token: issueSessionToken('store_owner') });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Lỗi xác thực đăng nhập.',
      });
    }
  });

  // 4. Read Entire Database State from Vercel Blob Store (taphoadungcanh-blob)
  router.get('/api/db/state', requireAuth, async (req, res) => {
    try {
      const force = req.query.refresh === '1';
      const dbData = await loadBlobDatabase(force);
      return res.json({
        storeId: dbData.storeId,
        updatedAtIso: dbData.updatedAtIso,
        blobConnected: Boolean(getBlobToken()),
        storeProfile: dbData.storeProfile,
        products: Object.values(dbData.products),
        deletedBarcodes: dbData.deletedBarcodes,
        invoices: dbData.invoices,
        orderTabs: Array.isArray(dbData.orderTabs) ? dbData.orderTabs : [],
        activeTabId: dbData.activeTabId || '',
        currentInvoiceCode: dbData.currentInvoiceCode || '',
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Không thể tải dữ liệu từ taphoadungcanh-blob.',
      });
    }
  });

  // 5. Upsert Product into Vercel Blob Store (taphoadungcanh-blob)
  router.post('/api/db/products', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const cleanBarcode = String(body.barcode || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 64);
      const cleanName = String(body.name || '').trim().slice(0, 200);
      if (!cleanBarcode || !cleanName) {
        return res
          .status(400)
          .json({ error: 'Mã vạch và tên sản phẩm không được để trống.' });
      }

      const dbData = await loadBlobDatabase();
      const record: BlobProductRecord = {
        id: `blob_prod_${cleanBarcode}`,
        barcode: cleanBarcode,
        name: cleanName,
        category: String(body.category || 'Hàng tạp hóa khác')
          .trim()
          .slice(0, 100),
        unit: String(body.unit || 'Cái').trim().slice(0, 50),
        price: Math.max(0, Math.round(Number(body.price) || 0)),
        costPrice: Math.max(0, Math.round(Number(body.costPrice) || 0)),
        stock: Math.max(0, Math.round(Number(body.stock) || 0)),
        source: String(body.source || 'manual').trim().slice(0, 50),
        updatedAtIso: new Date().toISOString(),
      };

      dbData.products[cleanBarcode] = record;
      delete dbData.deletedBarcodes[cleanBarcode];

      const saveRes = await saveBlobDatabase(dbData);
      return res.json({
        product: record,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi lưu sản phẩm vào Blob Store.',
      });
    }
  });

  // 6. Batch Save Products Page into Vercel Blob Store (taphoadungcanh-blob)
  router.post('/api/db/products/batch', requireAuth, async (req, res) => {
    try {
      const items = Array.isArray(req.body?.products) ? req.body.products : [];
      if (items.length === 0 || items.length > 200) {
        return res
          .status(400)
          .json({ error: 'Số lượng sản phẩm đồng bộ mỗi lần từ 1 đến 200 mã.' });
      }

      const dbData = await loadBlobDatabase();
      let count = 0;
      const nowIso = new Date().toISOString();

      for (const raw of items) {
        const cleanBarcode = String(raw?.barcode || '')
          .trim()
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 64);
        const cleanName = String(raw?.name || '').trim().slice(0, 200);
        if (!cleanBarcode || !cleanName) continue;

        dbData.products[cleanBarcode] = {
          id: `blob_prod_${cleanBarcode}`,
          barcode: cleanBarcode,
          name: cleanName,
          category: String(raw?.category || 'Hàng tạp hóa khác')
            .trim()
            .slice(0, 100),
          unit: String(raw?.unit || 'Cái').trim().slice(0, 50),
          price: Math.max(0, Math.round(Number(raw?.price) || 0)),
          costPrice: Math.max(0, Math.round(Number(raw?.costPrice) || 0)),
          stock: Math.max(0, Math.round(Number(raw?.stock) || 0)),
          source: String(raw?.source || 'catalog_vn_9000').trim().slice(0, 50),
          updatedAtIso: nowIso,
        };
        count += 1;
      }

      const saveRes = await saveBlobDatabase(dbData);
      return res.json({
        syncedCount: count,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi đồng bộ danh sách sản phẩm lên Blob Store.',
      });
    }
  });

  // 7. Delete Product from Vercel Blob Store (taphoadungcanh-blob)
  router.delete('/api/db/products/:barcode', requireAuth, async (req, res) => {
    try {
      const cleanBarcode = String(req.params.barcode || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '')
        .slice(0, 64);
      if (!cleanBarcode) {
        return res.status(400).json({ error: 'Mã vạch không hợp lệ.' });
      }

      const dbData = await loadBlobDatabase();
      delete dbData.products[cleanBarcode];
      dbData.deletedBarcodes[cleanBarcode] = true;

      const saveRes = await saveBlobDatabase(dbData);
      return res.json({
        deletedBarcode: cleanBarcode,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi xóa sản phẩm trong Blob Store.',
      });
    }
  });

  // 8. Save Printed Thermal Invoice & Deduct Stock in Vercel Blob Store
  router.post('/api/db/invoices', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const invoiceCode = String(body.invoiceCode || '')
        .trim()
        .slice(0, 64);
      const itemsJson = String(body.itemsJson || '[]').slice(0, 8000);
      if (!invoiceCode) {
        return res.status(400).json({ error: 'Thiếu mã hóa đơn.' });
      }

      const dbData = await loadBlobDatabase();
      const nowIso = new Date().toISOString();
      const newInvoice: BlobInvoiceRecord = {
        id: `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        invoiceCode,
        tabName: String(body.tabName || 'Phiếu 1').slice(0, 100),
        customerName: String(body.customerName || 'Khách lẻ').slice(0, 150),
        itemsJson,
        itemCount: Math.max(1, Math.round(Number(body.itemCount) || 1)),
        subtotal: Math.max(0, Math.round(Number(body.subtotal) || 0)),
        discount: Math.max(0, Math.round(Number(body.discount) || 0)),
        totalAmount: Math.max(0, Math.round(Number(body.totalAmount) || 0)),
        amountTendered: Math.max(0, Math.round(Number(body.amountTendered) || 0)),
        changeDue: Math.max(0, Math.round(Number(body.changeDue) || 0)),
        paperWidth: body.paperWidth === '58mm' ? '58mm' : '80mm',
        createdAtIso: nowIso,
      };

      // Prepend newest invoice
      dbData.invoices = [newInvoice, ...dbData.invoices].slice(0, 2000);

      // Deduct stock for sold items
      try {
        const parsedLines = JSON.parse(itemsJson) as Array<{
          barcode?: string;
          name?: string;
          unit?: string;
          price?: number;
          quantity?: number;
        }>;
        for (const line of parsedLines) {
          const code = String(line.barcode || '').trim();
          const qty = Math.max(1, Number(line.quantity) || 1);
          if (!code || code === 'HANG-LE') continue;

          const existingProd = dbData.products[code];
          if (existingProd) {
            existingProd.stock = Math.max(0, existingProd.stock - qty);
            existingProd.updatedAtIso = nowIso;
          } else if (VIETNAM_BARCODE_CATALOG[code]) {
            const catEntry = VIETNAM_BARCODE_CATALOG[code];
            dbData.products[code] = {
              id: `blob_prod_${code}`,
              barcode: code,
              name: catEntry.name,
              category: catEntry.category,
              unit: catEntry.unit,
              price: catEntry.suggestedPrice,
              costPrice: catEntry.suggestedCostPrice,
              stock: Math.max(0, catEntry.defaultStock - qty),
              source: 'catalog_vn_9000',
              updatedAtIso: nowIso,
            };
          }
        }
      } catch {
        // Ignore line parsing errors
      }

      const saveRes = await saveBlobDatabase(dbData);
      return res.json({
        invoice: newInvoice,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi lưu hóa đơn vào Blob Store.',
      });
    }
  });

  // 9. Delete Invoice from Vercel Blob Store
  router.delete('/api/db/invoices/:id', requireAuth, async (req, res) => {
    try {
      const targetId = String(req.params.id || '').trim();
      const dbData = await loadBlobDatabase();
      dbData.invoices = dbData.invoices.filter((inv) => inv.id !== targetId);
      const saveRes = await saveBlobDatabase(dbData);
      return res.json({
        deletedId: targetId,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi xóa hóa đơn trong Blob Store.',
      });
    }
  });

  // 9b. Update Existing Invoice ("Cập nhật bản lưu") or Save Copy ("Lưu bản sao") in Vercel Blob Store
  router.put('/api/db/invoices/:id', requireAuth, async (req, res) => {
    try {
      const targetId = String(req.params.id || '').trim();
      const body = req.body || {};
      const dbData = await loadBlobDatabase();
      const idx = dbData.invoices.findIndex((inv) => inv.id === targetId);
      if (idx === -1) {
        return res
          .status(404)
          .json({ error: 'Không tìm thấy bản lưu hóa đơn cần cập nhật.' });
      }

      const existing = dbData.invoices[idx];
      const itemsJson = String(body.itemsJson || existing.itemsJson).slice(
        0,
        8000
      );

      const updatedInvoice: BlobInvoiceRecord = {
        ...existing,
        invoiceCode: String(body.invoiceCode || existing.invoiceCode)
          .trim()
          .slice(0, 64),
        tabName: String(body.tabName || existing.tabName).slice(0, 100),
        customerName: String(body.customerName || existing.customerName).slice(
          0,
          150
        ),
        itemsJson,
        itemCount: Math.max(
          1,
          Math.round(Number(body.itemCount) || existing.itemCount || 1)
        ),
        subtotal: Math.max(0, Math.round(Number(body.subtotal) ?? existing.subtotal)),
        discount: Math.max(0, Math.round(Number(body.discount) ?? existing.discount)),
        totalAmount: Math.max(
          0,
          Math.round(Number(body.totalAmount) ?? existing.totalAmount)
        ),
        amountTendered: Math.max(
          0,
          Math.round(Number(body.amountTendered) ?? existing.amountTendered)
        ),
        changeDue: Math.max(
          0,
          Math.round(Number(body.changeDue) ?? existing.changeDue)
        ),
        paperWidth:
          body.paperWidth === '58mm'
            ? '58mm'
            : body.paperWidth === '80mm'
              ? '80mm'
              : existing.paperWidth,
      };

      dbData.invoices[idx] = updatedInvoice;
      const saveRes = await saveBlobDatabase(dbData);
      return res.json({
        invoice: updatedInvoice,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi cập nhật bản lưu hóa đơn trong Blob Store.',
      });
    }
  });

  // 9c. Full Database Backup Copy ("Lưu bản sao CSDL") & Update/Restore Database ("Cập nhật bản lưu CSDL")
  router.post('/api/db/backup-copy', requireAuth, async (req, res) => {
    try {
      const dbData = await loadBlobDatabase(true);
      const rawLabel = String(req.body?.label || '')
        .trim()
        .replace(/[^a-zA-Z0-9_-]/g, '_');
      const timestampSlug = new Date()
        .toISOString()
        .replace(/[:.]/g, '-')
        .slice(0, 19);
      const copyPathname = `taphoadungcanh-blob/backups/backup-${timestampSlug}${
        rawLabel ? `-${rawLabel.slice(0, 24)}` : ''
      }.json`;

      const serialized = JSON.stringify(dbData, null, 2);
      const token = getBlobToken();
      let blobUrl = '';

      if (token) {
        const blobResult = await putBlobWithPrivateFirst(
          copyPathname,
          serialized,
          token
        );
        blobUrl = blobResult.url;
      }

      // Also update main database snapshot
      const mainSave = await saveBlobDatabase(dbData);

      return res.json({
        copyPathname,
        blobUrl,
        savedToVercelBlob: mainSave.savedToVercelBlob,
        backupSnapshot: {
          version: dbData.version,
          storeId: dbData.storeId,
          updatedAtIso: dbData.updatedAtIso,
          storeProfile: dbData.storeProfile,
          products: dbData.products,
          deletedBarcodes: dbData.deletedBarcodes,
          invoices: dbData.invoices,
          orderTabs: dbData.orderTabs || [],
          activeTabId: dbData.activeTabId || '',
          currentInvoiceCode: dbData.currentInvoiceCode || '',
        },
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Không thể lưu bản sao cơ sở dữ liệu.',
      });
    }
  });

  router.put('/api/db/restore-or-update', requireAuth, async (req, res) => {
    try {
      const incoming = req.body?.snapshot;
      const replaceMode = Boolean(req.body?.replaceMode);
      const dbData = await loadBlobDatabase(true);

      if (incoming && typeof incoming === 'object') {
        if (
          incoming.storeProfile &&
          typeof incoming.storeProfile === 'object'
        ) {
          dbData.storeProfile = {
            ...DEFAULT_STORE_PROFILE,
            ...dbData.storeProfile,
            ...incoming.storeProfile,
          };
        }

        if (incoming.products && typeof incoming.products === 'object') {
          if (replaceMode) {
            dbData.products = {};
          }
          if (Array.isArray(incoming.products)) {
            for (const p of incoming.products) {
              const code = String(p?.barcode || '')
                .trim()
                .replace(/[^a-zA-Z0-9_-]/g, '')
                .slice(0, 64);
              if (!code) continue;
              dbData.products[code] = {
                id: `blob_prod_${code}`,
                barcode: code,
                name: String(p.name || '').slice(0, 200),
                category: String(p.category || 'Hàng tạp hóa khác').slice(
                  0,
                  100
                ),
                unit: String(p.unit || 'Cái').slice(0, 50),
                price: Math.max(0, Math.round(Number(p.price) || 0)),
                costPrice: Math.max(0, Math.round(Number(p.costPrice) || 0)),
                stock: Math.max(0, Math.round(Number(p.stock) || 0)),
                source: String(p.source || 'backup_restore').slice(0, 50),
                updatedAtIso: new Date().toISOString(),
              };
            }
          } else {
            for (const [key, val] of Object.entries(incoming.products)) {
              const p = val as Record<string, unknown>;
              const code = String(p?.barcode || key)
                .trim()
                .replace(/[^a-zA-Z0-9_-]/g, '')
                .slice(0, 64);
              if (!code) continue;
              dbData.products[code] = {
                id: `blob_prod_${code}`,
                barcode: code,
                name: String(p?.name || '').slice(0, 200),
                category: String(p?.category || 'Hàng tạp hóa khác').slice(
                  0,
                  100
                ),
                unit: String(p?.unit || 'Cái').slice(0, 50),
                price: Math.max(0, Math.round(Number(p?.price) || 0)),
                costPrice: Math.max(0, Math.round(Number(p?.costPrice) || 0)),
                stock: Math.max(0, Math.round(Number(p?.stock) || 0)),
                source: String(p?.source || 'backup_restore').slice(0, 50),
                updatedAtIso: new Date().toISOString(),
              };
            }
          }
        }

        if (
          incoming.deletedBarcodes &&
          typeof incoming.deletedBarcodes === 'object'
        ) {
          dbData.deletedBarcodes = replaceMode
            ? { ...incoming.deletedBarcodes }
            : {
                ...dbData.deletedBarcodes,
                ...incoming.deletedBarcodes,
              };
        }

        if (Array.isArray(incoming.invoices)) {
          const normalizedInvoices: BlobInvoiceRecord[] = [];
          const seenIds = new Set<string>();

          const sourceList = replaceMode
            ? incoming.invoices
            : [...incoming.invoices, ...dbData.invoices];

          for (const rawInv of sourceList) {
            if (!rawInv || typeof rawInv !== 'object') continue;
            const invId = String(
              rawInv.id ||
                `inv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
            );
            if (seenIds.has(invId)) continue;
            seenIds.add(invId);

            normalizedInvoices.push({
              id: invId,
              invoiceCode: String(rawInv.invoiceCode || invId).slice(0, 64),
              tabName: String(rawInv.tabName || 'Phiếu 1').slice(0, 100),
              customerName: String(rawInv.customerName || 'Khách lẻ').slice(
                0,
                150
              ),
              itemsJson: String(rawInv.itemsJson || '[]').slice(0, 8000),
              itemCount: Math.max(1, Math.round(Number(rawInv.itemCount) || 1)),
              subtotal: Math.max(0, Math.round(Number(rawInv.subtotal) || 0)),
              discount: Math.max(0, Math.round(Number(rawInv.discount) || 0)),
              totalAmount: Math.max(
                0,
                Math.round(Number(rawInv.totalAmount) || 0)
              ),
              amountTendered: Math.max(
                0,
                Math.round(Number(rawInv.amountTendered) || 0)
              ),
              changeDue: Math.max(0, Math.round(Number(rawInv.changeDue) || 0)),
              paperWidth: rawInv.paperWidth === '58mm' ? '58mm' : '80mm',
              createdAtIso: String(
                rawInv.createdAtIso || new Date().toISOString()
              ),
            });
          }
          dbData.invoices = normalizedInvoices.slice(0, 2000);
        }

        // Persist active POS order tabs, activeTabId, and currentInvoiceCode so any device opening the app sees the exact same bills in memory!
        if (Array.isArray(incoming.orderTabs)) {
          dbData.orderTabs = incoming.orderTabs
            .slice(0, 30)
            .map((t: Record<string, unknown>, idx: number) => ({
              id: String(t?.id || `tab_${idx + 1}`),
              tabNumber: Math.max(1, Number(t?.tabNumber) || idx + 1),
              label: String(t?.label || `Phiếu ${idx + 1}`).slice(0, 80),
              customerName: String(t?.customerName || 'Khách lẻ').slice(0, 150),
              createdAtIso: String(
                t?.createdAtIso || new Date().toISOString()
              ),
              items: Array.isArray(t?.items)
                ? t.items.slice(0, 300).map((item: Record<string, unknown>) => ({
                    lineId: String(
                      item?.lineId ||
                        `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
                    ),
                    productId: item?.productId
                      ? String(item.productId)
                      : undefined,
                    barcode: String(item?.barcode || 'HANG-LE').slice(0, 64),
                    name: String(item?.name || 'Hàng tạp hóa').slice(0, 200),
                    unit: String(item?.unit || 'Cái').slice(0, 50),
                    price: Math.max(0, Math.round(Number(item?.price) || 0)),
                    quantity: Math.max(
                      1,
                      Math.round(Number(item?.quantity) || 1)
                    ),
                  }))
                : [],
              discount: Math.max(0, Math.round(Number(t?.discount) || 0)),
              amountTendered: Math.max(
                0,
                Math.round(Number(t?.amountTendered) || 0)
              ),
              savedInvoiceId: t?.savedInvoiceId
                ? String(t.savedInvoiceId)
                : undefined,
              savedInvoiceCode: t?.savedInvoiceCode
                ? String(t.savedInvoiceCode)
                : undefined,
            }));
        }

        if (typeof incoming.activeTabId === 'string') {
          dbData.activeTabId = incoming.activeTabId.slice(0, 100);
        }
        if (typeof incoming.currentInvoiceCode === 'string') {
          dbData.currentInvoiceCode = incoming.currentInvoiceCode.slice(0, 64);
        }
      }

      const saveRes = await saveBlobDatabase(dbData);
      return res.json({
        updatedAtIso: dbData.updatedAtIso,
        productCount: Object.keys(dbData.products).length,
        invoiceCount: dbData.invoices.length,
        tabCount: Array.isArray(dbData.orderTabs) ? dbData.orderTabs.length : 0,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi cập nhật bản lưu cơ sở dữ liệu.',
      });
    }
  });

  // 10. Save Store Profile & Bank QR Configuration to Vercel Blob Store
  router.put('/api/db/profile', requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      const dbData = await loadBlobDatabase();
      dbData.storeProfile = {
        storeName: String(
          body.storeName || dbData.storeProfile.storeName
        ).slice(0, 120),
        address: String(body.address || dbData.storeProfile.address).slice(
          0,
          250
        ),
        phone: String(body.phone || dbData.storeProfile.phone).slice(0, 60),
        footerNote: String(
          body.footerNote || dbData.storeProfile.footerNote
        ).slice(0, 200),
        paperWidth: body.paperWidth === '58mm' ? '58mm' : '80mm',
        bankBin: String(body.bankBin || '970436').slice(0, 20),
        bankShortName: String(body.bankShortName || 'VCB').slice(0, 30),
        bankAccountNumber: String(body.bankAccountNumber || '').slice(0, 50),
        bankAccountName: String(body.bankAccountName || '').slice(0, 120),
        bankQrNoteTemplate: String(body.bankQrNoteTemplate || 'TT').slice(
          0,
          60
        ),
        customQrDataUrl: String(body.customQrDataUrl || '').slice(0, 1500000),
      };

      const saveRes = await saveBlobDatabase(dbData);
      return res.json({
        storeProfile: dbData.storeProfile,
        savedToVercelBlob: saveRes.savedToVercelBlob,
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error
            ? error.message
            : 'Lỗi lưu cấu hình cửa hàng & mã QR vào Blob Store.',
      });
    }
  });

  // 11. Automatic Barcode Product Lookup
  router.post('/api/barcode/lookup', async (req, res) => {
    try {
      const rawBarcode = String(req.body?.barcode || '').trim();
      const barcode = rawBarcode.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

      if (!barcode) {
        return res
          .status(400)
          .json({ error: 'Vui lòng cung cấp mã vạch hợp lệ.' });
      }

      // Check in Blob Database first
      const dbData = await loadBlobDatabase();
      if (dbData.products[barcode]) {
        const p = dbData.products[barcode];
        return res.json({
          found: true,
          source: 'taphoadungcanh_blob',
          sourceLabel: 'Kho hàng taphoadungcanh-blob',
          product: {
            barcode: p.barcode,
            name: p.name,
            category: p.category,
            unit: p.unit,
            price: p.price,
            costPrice: p.costPrice,
          },
        });
      }

      // Check 20,738+ Built-in Vietnamese grocery barcode catalog
      const catalogHit = VIETNAM_BARCODE_CATALOG[barcode];
      if (catalogHit) {
        return res.json({
          found: true,
          source: 'catalog_vn',
          sourceLabel: 'Danh mục chuẩn Tạp Hóa Việt Nam (20.700+ mã)',
          product: {
            barcode: catalogHit.barcode,
            name: catalogHit.name,
            category: catalogHit.category,
            unit: catalogHit.unit,
            price: catalogHit.suggestedPrice,
            costPrice: catalogHit.suggestedCostPrice,
          },
        });
      }

      // Query OpenFoodFacts, OpenBeautyFacts, OpenProductsFacts in parallel
      const [foodHit, beautyHit, productHit] = await Promise.all([
        queryOpenFactsRegistry('world.openfoodfacts.org', barcode),
        queryOpenFactsRegistry('world.openbeautyfacts.org', barcode),
        queryOpenFactsRegistry('world.openproductsfacts.org', barcode),
      ]);

      const registryHit = foodHit || beautyHit || productHit;
      if (registryHit) {
        const inferred = inferCategoryAndUnit(
          registryHit.name,
          registryHit.categories
        );
        return res.json({
          found: true,
          source: 'global_barcode_registry',
          sourceLabel: 'Tra cứu dữ liệu mã vạch trực tuyến',
          product: {
            barcode,
            name: registryHit.name,
            category: inferred.category,
            unit: inferred.unit,
            price: inferred.suggestedPrice,
            costPrice: Math.round(inferred.suggestedPrice * 0.85),
          },
        });
      }

      // Check GS1 Vietnam / ASEAN Manufacturer Prefix
      const matchedPrefix = GS1_BRAND_PREFIXES.find((item) =>
        barcode.startsWith(item.prefix)
      );
      if (matchedPrefix) {
        return res.json({
          found: true,
          source: 'gs1_prefix_vn',
          sourceLabel: `Nhận diện mã doanh nghiệp GS1 (${matchedPrefix.brand})`,
          product: {
            barcode,
            name: `${matchedPrefix.brand} #${barcode.slice(-4)}`,
            category: matchedPrefix.category,
            unit: matchedPrefix.defaultUnit,
            price: matchedPrefix.defaultPrice,
            costPrice: Math.round(matchedPrefix.defaultPrice * 0.85),
          },
        });
      }

      const countryHint = barcode.startsWith('893')
        ? 'Hàng Việt Nam'
        : barcode.startsWith('885')
          ? 'Hàng Thái Lan'
          : 'Hàng tạp hóa';

      return res.json({
        found: false,
        source: 'auto_template',
        sourceLabel: 'Mã vạch mới - Đã điền mẫu tự động',
        product: {
          barcode,
          name: `${countryHint} #${barcode.slice(-4)}`,
          category: 'Hàng tạp hóa khác',
          unit: 'Cái',
          price: 10000,
          costPrice: 8000,
        },
      });
    } catch (error) {
      return res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Lỗi khi tra cứu mã vạch.',
      });
    }
  });

  return router;
}
