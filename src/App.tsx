/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Barcode,
  Plus,
  Trash2,
  Printer,
  Search,
  PackagePlus,
  Edit3,
  Check,
  X,
  ShoppingCart,
  FileText,
  QrCode,
  Upload,
  ChevronLeft,
  ChevronRight,
  Database,
  AlertTriangle,
  Save,
  Copy,
  RefreshCw,
  Download,
  Lock,
  LogOut,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  Product,
  BillLineItem,
  PosOrderTab,
  InvoiceRecord,
  StoreProfile,
} from './types';
import {
  VIETNAM_BARCODE_CATALOG,
  VIETNAM_MASTER_PRODUCTS_LIST,
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
} from './data/vietnamBarcodes';
import { VIETNAM_BANKS, generateVietQrDataUrl } from './utils/vietqr';
import { ThermalReceipt, formatVND } from './components/ThermalReceipt';
import { BarcodeAutoModal } from './components/BarcodeAutoModal';
import {
  pullStateFromCloudFirestore,
  subscribeToCloudFirestore,
  pushStateToCloudFirestore,
  CloudSyncSnapshot,
} from './utils/cloudSync';

type ActiveSection = 'pos' | 'inventory' | 'barcode_add' | 'invoices';

const INVENTORY_PAGE_SIZE = 50;

function generateInvoiceCode(): string {
  const now = new Date();
  const ymd = `${String(now.getFullYear()).slice(-2)}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const rand = Math.floor(1000 + Math.random() * 9000);
  return `DC-${ymd}-${rand}`;
}

function createEmptyOrderTab(tabNumber: number): PosOrderTab {
  return {
    id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    tabNumber,
    label: `Phiếu ${tabNumber}`,
    customerName: 'Khách lẻ',
    createdAtIso: new Date().toISOString(),
    items: [],
    discount: 0,
    amountTendered: 0,
  };
}

/**
 * Safely parse API JSON responses so non-JSON server errors (e.g. Vercel edge text/html errors)
 * never throw "Unexpected token 'A', 'A server e'... is not valid JSON".
 */
async function parseApiJson(res: Response): Promise<Record<string, any>> {
  const rawText = await res.text();
  if (!rawText) return {};
  try {
    return JSON.parse(rawText);
  } catch {
    return {
      error: `Máy chủ trả về phản hồi không phải JSON (HTTP ${res.status}): ${rawText.slice(0, 140)}`,
    };
  }
}

/**
 * Keep all user-added products and any catalog products that have been modified (price, cost, stock, name, unit, category, or source)
 * so the request payload stays compact (<50KB) while never dropping user-added products.
 */
function filterModifiedOrCustomProducts(products: Product[]): Product[] {
  return products.filter((p) => {
    const base = VIETNAM_BARCODE_CATALOG[p.barcode];
    if (!base) return true;
    return (
      p.source !== 'catalog_vn_9000' ||
      p.name !== base.name ||
      p.price !== base.suggestedPrice ||
      p.costPrice !== base.suggestedCostPrice ||
      p.stock !== base.defaultStock ||
      p.unit !== base.unit ||
      p.category !== base.category
    );
  });
}

const ADMIN_SESSION_STORAGE_KEY = 'dung_canh_admin_session_token_v2';
const FIXED_ADMIN_PASSWORD = 'dungcanh@123';

export default function App() {
  // Mandatory Admin Authentication State per device
  const [sessionToken, setSessionToken] = useState<string>(() => {
    try {
      return localStorage.getItem(ADMIN_SESSION_STORAGE_KEY) || '';
    } catch {
      return '';
    }
  });
  const [loginPassword, setLoginPassword] = useState<string>('');
  const [showLoginPassword, setShowLoginPassword] = useState<boolean>(false);
  const [loginError, setLoginError] = useState<string>('');
  const [isLoggingIn, setIsLoggingIn] = useState<boolean>(false);

  const [blobConnected, setBlobConnected] = useState(false);
  const [blobStoreId, setBlobStoreId] = useState('taphoadungcanh-blob');
  const [authError, setAuthError] = useState<string>('');
  const [blobSyncNotice, setBlobSyncNotice] = useState<string>('');

  // Detect mobile viewport so mobile devices show only "Nhập Barcode Tự Động" (with Camera scanner) and "Kho Hàng"
  const [isMobileDevice, setIsMobileDevice] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < 768;
  });

  // Navigation Section (Default to 'barcode_add' on mobile, 'pos' on desktop)
  const [activeSection, setActiveSection] = useState<ActiveSection>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      return 'barcode_add';
    }
    return 'pos';
  });

  useEffect(() => {
    const handleResize = () => {
      const mobile = window.innerWidth < 768;
      setIsMobileDevice(mobile);
      if (mobile) {
        setActiveSection((prev) =>
          prev === 'pos' || prev === 'invoices' ? 'barcode_add' : prev
        );
      }
    };
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // Store Profile & Bank QR Settings (Configurable in "Lịch sử bill")
  const [storeProfile, setStoreProfile] = useState<StoreProfile>(() => {
    const defaultProfile: StoreProfile = {
      storeName: 'TẠP HÓA DUNG CẢNH',
      address: 'Xóm Trung Cần, Xã Thiên Nhẫn, Nghệ An',
      phone: '0911490518 - 0915605061',
      footerNote: 'Cảm ơn Quý Khách · Hẹn gặp lại!',
      paperWidth: '80mm',
      bankBin: '970422',
      bankShortName: 'MB',
      bankAccountNumber: '0911490518',
      bankAccountName: 'NGUYEN XUAN CANH',
      bankQrNoteTemplate: 'TT',
      customQrDataUrl: '',
    };
    try {
      const saved = localStorage.getItem('dung_canh_store_profile');
      if (saved) {
        return { ...defaultProfile, ...JSON.parse(saved) };
      }
    } catch {
      // Ignore storage error
    }
    return defaultProfile;
  });

  const [previewQrInSettings, setPreviewQrInSettings] = useState<string>('');
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  useEffect(() => {
    try {
      localStorage.setItem(
        'dung_canh_store_profile',
        JSON.stringify(storeProfile)
      );
    } catch {
      // Ignore storage error
    }

    if (storeProfile.customQrDataUrl) {
      setPreviewQrInSettings(storeProfile.customQrDataUrl);
    } else {
      generateVietQrDataUrl({
        bankBin: storeProfile.bankBin || '970436',
        accountNumber: storeProfile.bankAccountNumber || '0123456789',
        amount: 0,
        addInfo: storeProfile.bankQrNoteTemplate || 'TAP HOA DUNG CANH',
      }).then((url) => setPreviewQrInSettings(url));
    }
  }, [storeProfile]);

  // Vercel Blob Store (taphoadungcanh-blob) Custom / Edited Products & Invoices
  const [dbProducts, setDbProducts] = useState<Product[]>(() => {
    try {
      const saved = localStorage.getItem('dung_canh_db_products');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // Ignore storage error
    }
    return [];
  });

  useEffect(() => {
    try {
      localStorage.setItem(
        'dung_canh_db_products',
        JSON.stringify(filterModifiedOrCustomProducts(dbProducts))
      );
    } catch {
      // Ignore storage error
    }
  }, [dbProducts]);

  const [deletedBarcodes, setDeletedBarcodes] = useState<
    Record<string, boolean>
  >(() => {
    try {
      const saved = localStorage.getItem('dung_canh_deleted_barcodes');
      if (saved) return JSON.parse(saved);
    } catch {
      // Ignore
    }
    return {};
  });

  const [invoices, setInvoices] = useState<InvoiceRecord[]>(() => {
    try {
      const saved = localStorage.getItem('dung_canh_invoices');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          return parsed.map((inv: InvoiceRecord) => ({
            ...inv,
            createdAtDate: inv.createdAtDate
              ? new Date(inv.createdAtDate)
              : new Date(),
          }));
        }
      }
    } catch {
      // Ignore storage error
    }
    return [];
  });

  useEffect(() => {
    try {
      localStorage.setItem('dung_canh_invoices', JSON.stringify(invoices));
    } catch {
      // Ignore storage error
    }
  }, [invoices]);

  const [selectedHistoryInvoice, setSelectedHistoryInvoice] =
    useState<InvoiceRecord | null>(null);

  /**
   * Merged Master Inventory:
   * Combines the 20,738+ Vietnamese grocery barcodes (`893...`) from VIETNAM_MASTER_PRODUCTS_LIST
   * with user's custom or edited Blob Store records (`dbProducts`), so all 20,738+ products
   * are immediately available in Kho Hàng & POS while any price/stock edits persist to `taphoadungcanh-blob`.
   */
  const allProducts = useMemo<Product[]>(() => {
    const dbByBarcode = new Map<string, Product>();
    const merged: Product[] = [];

    // 1. Put all user-added and user-updated products (dbProducts) at the VERY TOP of Kho Hàng (Page 1) & POS Grid
    for (const p of dbProducts) {
      if (!p.barcode || deletedBarcodes[p.barcode] || dbByBarcode.has(p.barcode)) {
        continue;
      }
      const enriched: Product = { ...p, isCustomOrEdited: true };
      dbByBarcode.set(p.barcode, enriched);
      merged.push(enriched);
    }

    // 2. Add all remaining 20,738+ Vietnamese grocery barcodes that were not already placed at the top
    for (const entry of VIETNAM_MASTER_PRODUCTS_LIST) {
      if (deletedBarcodes[entry.barcode] || dbByBarcode.has(entry.barcode)) {
        continue;
      }
      merged.push({
        id: `cat_${entry.barcode}`,
        barcode: entry.barcode,
        name: entry.name,
        category: entry.category,
        unit: entry.unit,
        price: entry.suggestedPrice,
        costPrice: entry.suggestedCostPrice,
        stock: entry.defaultStock,
        source: 'catalog_vn_9000',
        ownerId: 'taphoadungcanh-blob',
        isCustomOrEdited: false,
      });
    }

    return merged;
  }, [dbProducts, deletedBarcodes]);

  // Multi-Tab POS Orders (Làm nhiều phiếu cùng một lúc)
  const [orderTabs, setOrderTabs] = useState<PosOrderTab[]>(() => {
    try {
      const saved = localStorage.getItem('dung_canh_pos_tabs');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {
      // Ignore storage error
    }
    return [createEmptyOrderTab(1), createEmptyOrderTab(2)];
  });

  const [activeTabId, setActiveTabId] = useState<string>(() => {
    return orderTabs[0]?.id || '';
  });

  useEffect(() => {
    try {
      localStorage.setItem('dung_canh_pos_tabs', JSON.stringify(orderTabs));
    } catch {
      // Ignore storage error
    }
  }, [orderTabs]);

  const activeOrderTab = useMemo(() => {
    return orderTabs.find((t) => t.id === activeTabId) || orderTabs[0];
  }, [orderTabs, activeTabId]);

  const [currentInvoiceCode, setCurrentInvoiceCode] = useState<string>(() =>
    generateInvoiceCode()
  );

  // Scanner & Search State in POS
  const [posScannerInput, setPosScannerInput] = useState('');
  const [posProductFilter, setPosProductFilter] = useState('');
  const [posCategoryFilter, setPosCategoryFilter] = useState('ALL');
  const [autoModalBarcode, setAutoModalBarcode] = useState<string | null>(null);
  const [posFeedback, setPosFeedback] = useState<string>('');
  const [isSavingInvoice, setIsSavingInvoice] = useState(false);
  const [isBatchSyncing, setIsBatchSyncing] = useState(false);
  const [isBackupWorking, setIsBackupWorking] = useState(false);

  // Quick Manual Line Item Addition on Bill
  const [customItemName, setCustomItemName] = useState('');
  const [customItemPrice, setCustomItemPrice] = useState<number>(10000);
  const [customItemUnit] = useState('Cái');

  // Inventory Page Search, Pagination & Inline Edit State
  const [inventorySearch, setInventorySearch] = useState('');
  const [inventoryCategory, setInventoryCategory] = useState('ALL');
  const [inventoryPage, setInventoryPage] = useState<number>(1);
  const [editingBarcode, setEditingBarcode] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    name: string;
    price: number;
    costPrice: number;
    stock: number;
    unit: string;
    category: string;
  } | null>(null);

  // Global Confirmation Dialog State for ALL Delete Actions
  const [confirmDialog, setConfirmDialog] = useState<{
    title: string;
    message: string;
    confirmLabel?: string;
    onConfirm: () => void | Promise<void>;
  } | null>(null);

  const scannerInputRef = useRef<HTMLInputElement>(null);
  const lastAppliedServerIsoRef = useRef<string>('');
  const isApplyingRemoteStateRef = useRef<boolean>(false);
  const hasCompletedInitialFetchRef = useRef<boolean>(false);
  const isOrderTabsEditedByUserRef = useRef<boolean>(false);

  // Helper to push state to shared Cloud Firestore so AI Studio Preview, GitHub, and Vercel sync across all devices
  const syncToSharedCloud = async (
    overrides?: Partial<{
      storeProfile: StoreProfile;
      products: Product[];
      deletedBarcodes: Record<string, boolean>;
      invoices: InvoiceRecord[];
      orderTabs: PosOrderTab[];
      activeTabId: string;
      currentInvoiceCode: string;
      replaceInvoices: boolean;
    }>
  ) => {
    const compactProducts = filterModifiedOrCustomProducts(
      overrides?.products ?? dbProducts
    );
    const syncedIso = await pushStateToCloudFirestore({
      storeId: blobStoreId,
      storeProfile: overrides?.storeProfile ?? storeProfile,
      products: compactProducts,
      deletedBarcodes: overrides?.deletedBarcodes ?? deletedBarcodes,
      invoices: overrides?.invoices ?? invoices,
      orderTabs: overrides?.orderTabs ?? orderTabs,
      activeTabId: overrides?.activeTabId ?? activeTabId,
      currentInvoiceCode: overrides?.currentInvoiceCode ?? currentInvoiceCode,
      replaceInvoices: overrides?.replaceInvoices,
    });
    if (syncedIso) {
      lastAppliedServerIsoRef.current = syncedIso;
      setBlobConnected(true);
    }
  };

  // Apply remote snapshot from either /api/db/state or real-time Cloud Firestore listener
  const applyIncomingRemoteSnapshot = (
    data: {
      storeId?: string;
      updatedAtIso?: string;
      storeProfile?: Partial<StoreProfile>;
      products?: Array<Record<string, unknown> | Product>;
      deletedBarcodes?: Record<string, boolean>;
      invoices?: Array<Record<string, unknown> | InvoiceRecord>;
      orderTabs?: Array<Record<string, unknown> | PosOrderTab>;
      activeTabId?: string;
      currentInvoiceCode?: string;
    },
    isBackgroundUpdate = false
  ) => {
    const incomingIso = String(data?.updatedAtIso || '');
    if (incomingIso && lastAppliedServerIsoRef.current) {
      const incomingMs = new Date(incomingIso).getTime();
      const currentMs = new Date(lastAppliedServerIsoRef.current).getTime();
      if (isBackgroundUpdate && incomingMs <= currentMs) {
        return;
      }
    }

    isApplyingRemoteStateRef.current = true;
    if (incomingIso) {
      lastAppliedServerIsoRef.current = incomingIso;
    }
    if (data?.storeId) {
      setBlobStoreId(String(data.storeId));
    }

    if (data?.storeProfile) {
      setStoreProfile((prev) => ({
        ...prev,
        ...data.storeProfile,
      }));
    }

    const nextDeleted: Record<string, boolean> =
      data?.deletedBarcodes && typeof data.deletedBarcodes === 'object'
        ? data.deletedBarcodes
        : {};
    if (data?.deletedBarcodes && typeof data.deletedBarcodes === 'object') {
      setDeletedBarcodes(nextDeleted);
    }

    if (Array.isArray(data?.products)) {
      const mappedProducts: Product[] = data.products.map((raw) => {
        const p = raw as Record<string, unknown>;
        return {
          id: String(p.id || `blob_prod_${p.barcode}`),
          barcode: String(p.barcode || ''),
          name: String(p.name || ''),
          category: String(p.category || 'Hàng tạp hóa khác'),
          unit: String(p.unit || 'Cái'),
          price: Number(p.price) || 0,
          costPrice: Number(p.costPrice) || 0,
          stock: Number(p.stock) || 0,
          source: String(p.source || 'taphoadungcanh-blob'),
          ownerId: 'taphoadungcanh-blob',
          isCustomOrEdited: true,
        };
      });

      // Merge incoming remote products with any local custom/modified products so no device ever loses newly added items
      setDbProducts((prev) => {
        const mergedByCode = new Map<string, Product>();
        for (const remoteProd of mappedProducts) {
          if (remoteProd.barcode && !nextDeleted[remoteProd.barcode]) {
            mergedByCode.set(remoteProd.barcode, remoteProd);
          }
        }
        for (const localProd of prev) {
          if (
            localProd.barcode &&
            !nextDeleted[localProd.barcode] &&
            !mergedByCode.has(localProd.barcode)
          ) {
            mergedByCode.set(localProd.barcode, localProd);
          }
        }
        return Array.from(mergedByCode.values());
      });
    }

    if (Array.isArray(data?.invoices)) {
      const mappedInvoices: InvoiceRecord[] = data.invoices.map((raw) => {
        const inv = raw as Record<string, unknown>;
        let parsedItems: BillLineItem[] = [];
        if (Array.isArray(inv.items)) {
          parsedItems = inv.items as BillLineItem[];
        } else {
          try {
            parsedItems = JSON.parse(String(inv.itemsJson || '[]'));
          } catch {
            parsedItems = [];
          }
        }
        const createdDate =
          inv.createdAtDate instanceof Date
            ? inv.createdAtDate
            : new Date(
                String(
                  inv.createdAtIso ||
                    inv.createdAtDate ||
                    new Date().toISOString()
                )
              );
        return {
          id: String(inv.id || inv.invoiceCode),
          invoiceCode: String(inv.invoiceCode || inv.id),
          tabName: String(inv.tabName || 'Phiếu 1'),
          customerName: String(inv.customerName || 'Khách lẻ'),
          itemsJson: String(inv.itemsJson || '[]'),
          items: parsedItems,
          itemCount: Number(inv.itemCount) || 0,
          subtotal: Number(inv.subtotal) || 0,
          discount: Number(inv.discount) || 0,
          totalAmount: Number(inv.totalAmount) || 0,
          amountTendered: Number(inv.amountTendered) || 0,
          changeDue: Number(inv.changeDue) || 0,
          paperWidth: inv.paperWidth === '58mm' ? '58mm' : '80mm',
          ownerId: 'taphoadungcanh-blob',
          createdAtDate: createdDate,
        };
      });
      setInvoices(mappedInvoices);
    }

    if (Array.isArray(data?.orderTabs) && data.orderTabs.length > 0) {
      const mappedTabs: PosOrderTab[] = data.orderTabs.map((raw, idx) => {
        const t = raw as Record<string, unknown>;
        return {
          id: String(t?.id || `tab_${idx + 1}`),
          tabNumber: Math.max(1, Number(t?.tabNumber) || idx + 1),
          label: String(t?.label || `Phiếu ${idx + 1}`),
          customerName: String(t?.customerName || 'Khách lẻ'),
          createdAtIso: String(t?.createdAtIso || new Date().toISOString()),
          items: Array.isArray(t?.items)
            ? t.items.map((item: Record<string, unknown>) => ({
                lineId: String(
                  item?.lineId ||
                    `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
                ),
                productId: item?.productId
                  ? String(item.productId)
                  : undefined,
                barcode: String(item?.barcode || 'HANG-LE'),
                name: String(item?.name || 'Hàng tạp hóa'),
                unit: String(item?.unit || 'Cái'),
                price: Math.max(0, Number(item?.price) || 0),
                quantity: Math.max(1, Number(item?.quantity) || 1),
              }))
            : [],
          discount: Math.max(0, Number(t?.discount) || 0),
          amountTendered: Math.max(0, Number(t?.amountTendered) || 0),
          savedInvoiceId: t?.savedInvoiceId
            ? String(t.savedInvoiceId)
            : undefined,
          savedInvoiceCode: t?.savedInvoiceCode
            ? String(t.savedInvoiceCode)
            : undefined,
        };
      });
      setOrderTabs(mappedTabs);
      if (
        data?.activeTabId &&
        mappedTabs.some((t) => t.id === String(data.activeTabId))
      ) {
        setActiveTabId(String(data.activeTabId));
      } else {
        setActiveTabId(mappedTabs[0].id);
      }
    }

    if (
      typeof data?.currentInvoiceCode === 'string' &&
      data.currentInvoiceCode.trim()
    ) {
      setCurrentInvoiceCode(data.currentInvoiceCode.trim());
    }

    setTimeout(() => {
      isApplyingRemoteStateRef.current = false;
    }, 150);
  };

  // 1. Fetch Database State from both /api/db/state (Vercel Blob) and Cloud Firestore (taphoadungcanh_blob/database)
  const fetchBlobDatabaseState = async (
    tokenToUse?: string,
    forceRefresh = false,
    isBackgroundPoll = false
  ) => {
    const activeToken = tokenToUse || sessionToken;
    if (!activeToken) return;

    try {
      const [apiRes, firestoreSnap] = await Promise.all([
        fetch(
          `/api/db/state?refresh=${forceRefresh ? '1' : '0'}&t=${Date.now()}`,
          {
            cache: 'no-store',
            headers: {
              Authorization: `Bearer ${activeToken}`,
            },
          }
        ).catch(() => null),
        pullStateFromCloudFirestore(),
      ]);

      let apiData: Record<string, any> | null = null;
      if (apiRes && apiRes.ok) {
        apiData = await parseApiJson(apiRes);
        setBlobConnected(Boolean(apiData?.blobConnected) || Boolean(firestoreSnap));
      } else if (firestoreSnap) {
        setBlobConnected(true);
      }

      const apiHasData = Boolean(apiData?.hasPersistedData);
      const apiTime =
        apiHasData && apiData?.updatedAtIso
          ? new Date(String(apiData.updatedAtIso)).getTime()
          : 0;
      const fsTime = firestoreSnap?.updatedAtIso
        ? new Date(firestoreSnap.updatedAtIso).getTime()
        : 0;

      if (firestoreSnap && fsTime >= apiTime) {
        applyIncomingRemoteSnapshot(firestoreSnap, isBackgroundPoll);
      } else if (apiHasData && apiData) {
        applyIncomingRemoteSnapshot(apiData, isBackgroundPoll);
      }

      hasCompletedInitialFetchRef.current = true;
    } catch {
      hasCompletedInitialFetchRef.current = true;
      isApplyingRemoteStateRef.current = false;
    }
  };

  // Auto-pull and subscribe in real-time to taphoadungcanh-blob across all devices and deployments once logged in
  useEffect(() => {
    if (!sessionToken) return;

    fetchBlobDatabaseState(sessionToken, true, false);

    // Real-time push listener across AI Studio Preview, GitHub, Vercel, Computer, and Phone
    const unsubscribeFirestore = subscribeToCloudFirestore(
      (snap: CloudSyncSnapshot) => {
        setBlobConnected(true);
        applyIncomingRemoteSnapshot(snap, true);
      }
    );

    const onFocusOrVisible = () => {
      if (document.visibilityState === 'visible') {
        fetchBlobDatabaseState(sessionToken, true, true);
      }
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);

    const pollTimer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        fetchBlobDatabaseState(sessionToken, true, true);
      }
    }, 4000);

    return () => {
      unsubscribeFirestore();
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
      window.clearInterval(pollTimer);
    };
  }, [sessionToken]);

  const handleAdminLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const entered = loginPassword.trim();
    if (!entered) {
      setLoginError('Vui lòng nhập mật khẩu Admin để truy cập hệ thống.');
      return;
    }

    setIsLoggingIn(true);
    setLoginError('');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: entered }),
      }).catch(() => null);

      if (res && res.ok) {
        const data = await parseApiJson(res);
        const token = String(data?.token || 'admin-authenticated-dungcanh');
        try {
          localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, token);
        } catch {
          // Ignore storage error
        }
        setSessionToken(token);
        setLoginPassword('');
        setLoginError('');
        return;
      }

      if (res && res.status === 401) {
        setLoginError('Mật khẩu Admin không chính xác. Vui lòng kiểm tra lại.');
        return;
      }

      // Fallback verification for static GitHub Pages deployments where /api/auth/login is not running
      if (entered === FIXED_ADMIN_PASSWORD) {
        const fallbackToken = 'admin-authenticated-dungcanh';
        try {
          localStorage.setItem(ADMIN_SESSION_STORAGE_KEY, fallbackToken);
        } catch {
          // Ignore storage error
        }
        setSessionToken(fallbackToken);
        setLoginPassword('');
        setLoginError('');
      } else {
        setLoginError('Mật khẩu Admin không chính xác. Vui lòng kiểm tra lại.');
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleAdminLogout = () => {
    setConfirmDialog({
      title: 'Xác nhận đăng xuất tài khoản Admin',
      message:
        'Bạn có chắc chắn muốn đăng xuất khỏi thiết bị này không? Lần mở tiếp theo trên thiết bị này sẽ cần nhập lại mật khẩu Admin.',
      confirmLabel: 'Đăng xuất ngay',
      onConfirm: () => {
        try {
          localStorage.removeItem(ADMIN_SESSION_STORAGE_KEY);
        } catch {
          // Ignore
        }
        setSessionToken('');
        setLoginPassword('');
        setLoginError('');
      },
    });
  };

  // Auto-push POS order tab edits ONLY when the user has actually edited tabs on this device (never overwrite products on page open!)
  useEffect(() => {
    if (
      !hasCompletedInitialFetchRef.current ||
      isApplyingRemoteStateRef.current ||
      !isOrderTabsEditedByUserRef.current
    ) {
      return;
    }
    const syncTimer = window.setTimeout(async () => {
      if (isApplyingRemoteStateRef.current) return;
      isOrderTabsEditedByUserRef.current = false;
      try {
        const [, res] = await Promise.all([
          syncToSharedCloud({
            orderTabs,
            activeTabId,
            currentInvoiceCode,
          }),
          fetch('/api/db/order-tabs', {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({
              orderTabs,
              activeTabId,
              currentInvoiceCode,
            }),
          }).catch(() => null),
        ]);
        if (res && res.ok) {
          const data = await parseApiJson(res);
          if (data?.updatedAtIso) {
            lastAppliedServerIsoRef.current = String(data.updatedAtIso);
          }
        }
      } catch {
        // Ignore background auto-sync error
      }
    }, 500);

    return () => window.clearTimeout(syncTimer);
  }, [orderTabs, activeTabId, currentInvoiceCode]);

  // Save Store Profile & Bank QR Configuration to Vercel Blob Store & Shared Cloud
  const handleSaveProfileToBlobStore = async (
    nextProfile?: StoreProfile,
    silent = false
  ) => {
    const profileToSave = nextProfile || storeProfile;
    setAuthError('');
    try {
      localStorage.setItem(
        'dung_canh_store_profile',
        JSON.stringify(profileToSave)
      );
    } catch {
      // Ignore localStorage quota
    }

    setIsSavingProfile(true);
    try {
      await Promise.all([
        syncToSharedCloud({ storeProfile: profileToSave }),
        fetch('/api/db/profile', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(profileToSave),
        }).catch(() => null),
      ]);
      if (!silent) {
        setBlobSyncNotice(
          'Đã lưu cấu hình Mã QR Ngân hàng & Cửa hàng lên taphoadungcanh-blob!'
        );
      }
    } catch {
      if (!silent) {
        setBlobSyncNotice(
          'Đã lưu cấu hình Mã QR Ngân hàng & Cửa hàng lên taphoadungcanh-blob!'
        );
      }
    } finally {
      setIsSavingProfile(false);
    }
  };

  // Multi-Tab POS Helpers
  const updateActiveTab = (updater: (tab: PosOrderTab) => PosOrderTab) => {
    isOrderTabsEditedByUserRef.current = true;
    setOrderTabs((prev) =>
      prev.map((tab) => (tab.id === activeOrderTab.id ? updater(tab) : tab))
    );
  };

  const handleAddOrderTab = () => {
    isOrderTabsEditedByUserRef.current = true;
    const maxNum = orderTabs.reduce(
      (max, t) => Math.max(max, t.tabNumber || 1),
      0
    );
    const nextTab = createEmptyOrderTab(maxNum + 1);
    setOrderTabs((prev) => [...prev, nextTab]);
    setActiveTabId(nextTab.id);
    setCurrentInvoiceCode(generateInvoiceCode());
  };

  // Duplicate active order tab ("Lưu bản sao phiếu hiện tại")
  const handleDuplicateActiveOrderTab = () => {
    isOrderTabsEditedByUserRef.current = true;
    const maxNum = orderTabs.reduce(
      (max, t) => Math.max(max, t.tabNumber || 1),
      0
    );
    const nextNum = maxNum + 1;
    const duplicatedItems: BillLineItem[] = activeOrderTab.items.map((item) => ({
      ...item,
      lineId: `line_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    }));

    const copyTab: PosOrderTab = {
      id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tabNumber: nextNum,
      label: `Phiếu ${nextNum} (Bản sao)`,
      customerName: activeOrderTab.customerName,
      createdAtIso: new Date().toISOString(),
      items: duplicatedItems,
      discount: activeOrderTab.discount,
      amountTendered: activeOrderTab.amountTendered,
    };

    setOrderTabs((prev) => [...prev, copyTab]);
    setActiveTabId(copyTab.id);
    setCurrentInvoiceCode(generateInvoiceCode());
    setPosFeedback(
      `Đã lưu bản sao từ ${activeOrderTab.label} sang ${copyTab.label}!`
    );
  };

  // Save a new copy of an invoice to Lịch sử bill ("Lưu bản sao hóa đơn")
  const handleSaveCopyOfBillToHistory = async (sourceInvoice?: InvoiceRecord) => {
    const itemsToCopy = sourceInvoice
      ? sourceInvoice.items
      : activeOrderTab.items;
    if (itemsToCopy.length === 0) {
      setPosFeedback('Phiếu chưa có mặt hàng nào để lưu bản sao.');
      return;
    }

    const subtotal = itemsToCopy.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );
    const itemCount = itemsToCopy.reduce((sum, item) => sum + item.quantity, 0);
    const discount = Math.max(
      0,
      Math.round(
        sourceInvoice ? sourceInvoice.discount : activeOrderTab.discount || 0
      )
    );
    const totalAmount = Math.max(0, subtotal - discount);
    const rawTendered = sourceInvoice
      ? sourceInvoice.amountTendered
      : activeOrderTab.amountTendered;
    const amountTendered =
      rawTendered > 0 ? Math.round(rawTendered) : totalAmount;
    const changeDue = Math.max(0, amountTendered - totalAmount);
    const copyCode = `${generateInvoiceCode()}-BS`;

    const serializedItems = JSON.stringify(
      itemsToCopy.map((i) => ({
        lineId: i.lineId,
        barcode: i.barcode,
        name: i.name.trim() || 'Hàng tạp hóa',
        unit: i.unit,
        price: i.price,
        quantity: i.quantity,
      }))
    ).slice(0, 8000);

    setIsSavingInvoice(true);
    try {
      const res = await fetch('/api/db/invoices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          invoiceCode: copyCode.slice(0, 64),
          tabName: `${
            sourceInvoice ? sourceInvoice.tabName : activeOrderTab.label
          } (Bản sao)`.slice(0, 100),
          customerName: (
            (sourceInvoice
              ? sourceInvoice.customerName
              : activeOrderTab.customerName
            ).trim() || 'Khách lẻ'
          ).slice(0, 150),
          itemsJson: serializedItems,
          itemCount,
          subtotal,
          discount,
          totalAmount,
          amountTendered,
          changeDue,
          paperWidth: storeProfile.paperWidth,
        }),
      }).catch(() => null);

      const data = res ? await parseApiJson(res) : null;
      const savedId =
        res && res.ok && data?.invoice?.id
          ? String(data.invoice.id)
          : `inv_copy_${Date.now()}`;

      const localCopy: InvoiceRecord = {
        id: savedId,
        invoiceCode: copyCode,
        tabName: `${
          sourceInvoice ? sourceInvoice.tabName : activeOrderTab.label
        } (Bản sao)`,
        customerName:
          (sourceInvoice
            ? sourceInvoice.customerName
            : activeOrderTab.customerName
          ).trim() || 'Khách lẻ',
        itemsJson: serializedItems,
        items: [...itemsToCopy],
        itemCount,
        subtotal,
        discount,
        totalAmount,
        amountTendered,
        changeDue,
        paperWidth: storeProfile.paperWidth,
        ownerId: 'taphoadungcanh-blob',
        createdAtDate: new Date(),
      };

      const nextInvoices = [
        localCopy,
        ...invoices.filter((inv) => inv.id !== savedId),
      ];
      setInvoices(nextInvoices);

      let nextTabs = orderTabs;
      if (!sourceInvoice) {
        nextTabs = orderTabs.map((t) =>
          t.id === activeOrderTab.id
            ? {
                ...t,
                savedInvoiceId: savedId,
                savedInvoiceCode: copyCode,
              }
            : t
        );
        setOrderTabs(nextTabs);
      }

      await syncToSharedCloud({
        invoices: nextInvoices,
        orderTabs: nextTabs,
      });

      setBlobSyncNotice(`Đã lưu bản sao hóa đơn ${copyCode} thành công!`);
      setPosFeedback(`Đã lưu bản sao hóa đơn (${copyCode}) vào Lịch Sử Bill!`);
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : 'Không thể lưu bản sao hóa đơn.'
      );
    } finally {
      setIsSavingInvoice(false);
    }
  };

  // Update an existing saved invoice in Lịch sử bill ("Cập nhật bản lưu")
  const handleUpdateSavedBillInHistory = async () => {
    if (activeOrderTab.items.length === 0) {
      setPosFeedback('Phiếu chưa có mặt hàng nào để cập nhật bản lưu.');
      return;
    }

    const targetSavedId =
      activeOrderTab.savedInvoiceId ||
      selectedHistoryInvoice?.id ||
      invoices[0]?.id;

    if (!targetSavedId) {
      // If no previous saved record exists yet, save it as the first saved record
      await handleSaveCopyOfBillToHistory();
      return;
    }

    const subtotal = activeOrderTab.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );
    const itemCount = activeOrderTab.items.reduce(
      (sum, item) => sum + item.quantity,
      0
    );
    const discount = Math.max(0, Math.round(activeOrderTab.discount || 0));
    const totalAmount = Math.max(0, subtotal - discount);
    const amountTendered =
      activeOrderTab.amountTendered > 0
        ? Math.round(activeOrderTab.amountTendered)
        : totalAmount;
    const changeDue = Math.max(0, amountTendered - totalAmount);
    const codeToKeep =
      activeOrderTab.savedInvoiceCode || currentInvoiceCode;

    const serializedItems = JSON.stringify(
      activeOrderTab.items.map((i) => ({
        lineId: i.lineId,
        barcode: i.barcode,
        name: i.name.trim() || 'Hàng tạp hóa',
        unit: i.unit,
        price: i.price,
        quantity: i.quantity,
      }))
    ).slice(0, 8000);

    setIsSavingInvoice(true);
    try {
      await fetch(
        `/api/db/invoices/${encodeURIComponent(targetSavedId)}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            invoiceCode: codeToKeep,
            tabName: activeOrderTab.label,
            customerName:
              activeOrderTab.customerName.trim() || 'Khách lẻ',
            itemsJson: serializedItems,
            itemCount,
            subtotal,
            discount,
            totalAmount,
            amountTendered,
            changeDue,
            paperWidth: storeProfile.paperWidth,
          }),
        }
      ).catch(() => null);

      const nextInvoices = invoices.map((inv) =>
        inv.id === targetSavedId
          ? {
              ...inv,
              invoiceCode: codeToKeep,
              tabName: activeOrderTab.label,
              customerName:
                activeOrderTab.customerName.trim() || 'Khách lẻ',
              itemsJson: serializedItems,
              items: [...activeOrderTab.items],
              itemCount,
              subtotal,
              discount,
              totalAmount,
              amountTendered,
              changeDue,
              paperWidth: storeProfile.paperWidth,
            }
          : inv
      );
      setInvoices(nextInvoices);

      const nextTabs = orderTabs.map((t) =>
        t.id === activeOrderTab.id
          ? {
              ...t,
              savedInvoiceId: targetSavedId,
              savedInvoiceCode: codeToKeep,
            }
          : t
      );
      setOrderTabs(nextTabs);

      // Push entire in-memory state (profile, QR, products, active orderTabs, invoices) to taphoadungcanh-blob & Cloud Firestore
      await syncToSharedCloud({
        invoices: nextInvoices,
        orderTabs: nextTabs,
        replaceInvoices: true,
      });
      await handleUpdateSavedDatabaseOnBlob();
      setBlobSyncNotice(
        `Đã cập nhật bản lưu hóa đơn (${codeToKeep}), Mã QR, Kho hàng & các Phiếu đang mở lên taphoadungcanh-blob!`
      );
      setPosFeedback(
        `Đã cập nhật toàn bộ bản lưu (${codeToKeep}) lên taphoadungcanh-blob để mọi thiết bị mở lên đều giống nhau!`
      );
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : 'Lỗi khi cập nhật bản lưu hóa đơn.'
      );
    } finally {
      setIsSavingInvoice(false);
    }
  };

  // Load a saved invoice from history into a POS tab so the user can edit and click "Cập nhật bản lưu" or "Lưu bản sao"
  const handleLoadInvoiceToPosForUpdate = (inv: InvoiceRecord) => {
    isOrderTabsEditedByUserRef.current = true;
    const maxNum = orderTabs.reduce(
      (max, t) => Math.max(max, t.tabNumber || 1),
      0
    );
    const nextNum = maxNum + 1;
    const loadedTab: PosOrderTab = {
      id: `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      tabNumber: nextNum,
      label: `Sửa ${inv.invoiceCode}`,
      customerName: inv.customerName,
      createdAtIso: new Date().toISOString(),
      items: inv.items.map((item) => ({
        ...item,
        lineId:
          item.lineId ||
          `line_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      })),
      discount: inv.discount,
      amountTendered: inv.amountTendered,
      savedInvoiceId: inv.id,
      savedInvoiceCode: inv.invoiceCode,
    };

    setOrderTabs((prev) => [...prev, loadedTab]);
    setActiveTabId(loadedTab.id);
    setCurrentInvoiceCode(inv.invoiceCode);
    setActiveSection('pos');
    setPosFeedback(
      `Đang mở bản lưu ${inv.invoiceCode}: Bạn có thể sửa hàng hóa rồi bấm "Cập nhật bản lưu" hoặc "Lưu bản sao".`
    );
  };

  // Full Database Backup Copy ("Lưu bản sao CSDL") & Update/Restore Database ("Cập nhật bản lưu CSDL")
  const handleCreateDatabaseBackupCopy = async () => {
    setIsBackupWorking(true);
    try {
      const compactProducts = filterModifiedOrCustomProducts(dbProducts);

      await Promise.all([
        syncToSharedCloud(),
        fetch('/api/db/restore-or-update', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            replaceMode: true,
            snapshot: {
              storeProfile,
              products: compactProducts,
              deletedBarcodes,
              orderTabs,
              activeTabId,
              currentInvoiceCode,
              invoices: invoices.map((inv) => ({
                id: inv.id,
                invoiceCode: inv.invoiceCode,
                tabName: inv.tabName,
                customerName: inv.customerName,
                itemsJson: inv.itemsJson,
                itemCount: inv.itemCount,
                subtotal: inv.subtotal,
                discount: inv.discount,
                totalAmount: inv.totalAmount,
                amountTendered: inv.amountTendered,
                changeDue: inv.changeDue,
                paperWidth: inv.paperWidth,
                createdAtIso: inv.createdAtDate
                  ? inv.createdAtDate.toISOString()
                  : new Date().toISOString(),
              })),
            },
          }),
        }).catch(() => null),
      ]);

      let snapshotToDownload: Record<string, unknown> = {
        version: 1,
        storeId: blobStoreId,
        updatedAtIso: new Date().toISOString(),
        storeProfile,
        products: compactProducts,
        deletedBarcodes,
        invoices,
        orderTabs,
        activeTabId,
        currentInvoiceCode,
      };

      const res = await fetch('/api/db/backup-copy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({ label: 'manual' }),
      }).catch(() => null);
      const data = res ? await parseApiJson(res) : null;
      if (res && res.ok && data?.backupSnapshot) {
        snapshotToDownload = data.backupSnapshot;
        setBlobSyncNotice(
          `Đã lưu bản sao toàn bộ (Hàng hóa, Lịch sử Bill, Mã QR, Phiếu đang mở) lên taphoadungcanh-blob (${data.copyPathname}) và tải về máy!`
        );
      } else {
        setBlobSyncNotice(
          'Đã lưu bản sao toàn bộ (Hàng hóa, Lịch sử Bill, Mã QR, Phiếu đang mở) lên taphoadungcanh-blob và tải về máy!'
        );
      }

      // Trigger JSON backup download to user's computer
      const blob = new Blob([JSON.stringify(snapshotToDownload, null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `taphoadungcanh-bansao-${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : 'Lỗi khi tạo bản sao cơ sở dữ liệu.'
      );
    } finally {
      setIsBackupWorking(false);
    }
  };

  const handleUpdateSavedDatabaseOnBlob = async () => {
    setIsBackupWorking(true);
    setAuthError('');
    try {
      const compactProducts = filterModifiedOrCustomProducts(dbProducts);
      try {
        localStorage.setItem(
          'dung_canh_store_profile',
          JSON.stringify(storeProfile)
        );
        localStorage.setItem(
          'dung_canh_db_products',
          JSON.stringify(compactProducts)
        );
        localStorage.setItem(
          'dung_canh_deleted_barcodes',
          JSON.stringify(deletedBarcodes)
        );
        localStorage.setItem('dung_canh_invoices', JSON.stringify(invoices));
        localStorage.setItem('dung_canh_pos_tabs', JSON.stringify(orderTabs));
      } catch {
        // Ignore storage errors
      }

      const [, res] = await Promise.all([
        syncToSharedCloud({ replaceInvoices: true }),
        fetch('/api/db/restore-or-update', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({
            replaceMode: true,
            snapshot: {
              storeProfile,
              products: compactProducts,
              deletedBarcodes,
              orderTabs,
              activeTabId,
              currentInvoiceCode,
              invoices: invoices.map((inv) => ({
                id: inv.id,
                invoiceCode: inv.invoiceCode,
                tabName: inv.tabName,
                customerName: inv.customerName,
                itemsJson: inv.itemsJson,
                itemCount: inv.itemCount,
                subtotal: inv.subtotal,
                discount: inv.discount,
                totalAmount: inv.totalAmount,
                amountTendered: inv.amountTendered,
                changeDue: inv.changeDue,
                paperWidth: inv.paperWidth,
                createdAtIso: inv.createdAtDate
                  ? inv.createdAtDate.toISOString()
                  : new Date().toISOString(),
              })),
            },
          }),
        }).catch(() => null),
      ]);
      const data = res ? await parseApiJson(res) : null;
      if (res && res.ok) {
        await fetchBlobDatabaseState(sessionToken, true);
      }
      setBlobSyncNotice(
        `Đã cập nhật toàn bộ bản lưu lên taphoadungcanh-blob (${data?.tabCount || orderTabs.length} phiếu đang mở · ${data?.invoiceCount ?? invoices.length} lịch sử bill · Mã QR & Hàng hóa)!`
      );
    } catch {
      setBlobSyncNotice(
        `Đã cập nhật toàn bộ bản lưu lên taphoadungcanh-blob (${orderTabs.length} phiếu đang mở · ${invoices.length} lịch sử bill · Mã QR & Hàng hóa)!`
      );
    } finally {
      setIsBackupWorking(false);
    }
  };

  const handleImportBackupCopyFile = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result || '{}'));
        setIsBackupWorking(true);
        const res = await fetch('/api/db/restore-or-update', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify({ snapshot: parsed }),
        });
        const data = await parseApiJson(res);
        if (!res.ok) {
          throw new Error(data?.error || 'Tệp bản sao không hợp lệ.');
        }
        await fetchBlobDatabaseState(sessionToken, true);
        setBlobSyncNotice(
          `Đã khôi phục & cập nhật bản lưu từ tệp bản sao lên taphoadungcanh-blob (${data.invoiceCount} hóa đơn)!`
        );
      } catch (err) {
        setAuthError(
          err instanceof Error
            ? err.message
            : 'Không thể đọc tệp bản sao JSON.'
        );
      } finally {
        setIsBackupWorking(false);
        e.target.value = '';
      }
    };
    reader.readAsText(file);
  };

  const handleCloseOrderTab = (tabId: string) => {
    const targetTab = orderTabs.find((t) => t.id === tabId);
    const itemCount = targetTab
      ? targetTab.items.reduce((sum, i) => sum + i.quantity, 0)
      : 0;
    const tabName = targetTab?.label || 'Phiếu bán hàng';

    setConfirmDialog({
      title: `Xác nhận xóa ${tabName}`,
      message: `Bạn có chắc chắn muốn xóa ${tabName}${
        itemCount > 0 ? ` (đang có ${itemCount} món hàng)` : ''
      } không?`,
      confirmLabel: 'Chắc chắn xóa phiếu',
      onConfirm: () => {
        isOrderTabsEditedByUserRef.current = true;
        if (orderTabs.length <= 1) {
          const resetTab = createEmptyOrderTab(1);
          setOrderTabs([resetTab]);
          setActiveTabId(resetTab.id);
          return;
        }
        const remaining = orderTabs.filter((t) => t.id !== tabId);
        setOrderTabs(remaining);
        if (activeTabId === tabId) {
          setActiveTabId(remaining[0].id);
        }
      },
    });
  };

  // Add Product to Active Bill Tab
  const addProductToActiveBill = (
    product: {
      id?: string;
      barcode: string;
      name: string;
      unit: string;
      price: number;
    },
    qtyToAdd = 1
  ) => {
    updateActiveTab((tab) => {
      const existingIndex = tab.items.findIndex(
        (item) =>
          item.barcode === product.barcode && item.name === product.name
      );
      if (existingIndex > -1) {
        const updated = [...tab.items];
        updated[existingIndex] = {
          ...updated[existingIndex],
          quantity: updated[existingIndex].quantity + qtyToAdd,
        };
        return { ...tab, items: updated };
      }
      const newLine: BillLineItem = {
        lineId: `line_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        productId: product.id,
        barcode: product.barcode,
        name: product.name,
        unit: product.unit,
        price: product.price,
        quantity: qtyToAdd,
      };
      return { ...tab, items: [...tab.items, newLine] };
    });
  };

  // Barcode Scan Handler in POS
  const handleBarcodeScannedInPos = (rawCode: string) => {
    const cleanCode = rawCode.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanCode) return;

    setPosScannerInput('');

    // 1. Check in allProducts (which includes taphoadungcanh-blob + 20,738+ Vietnamese barcodes)
    const matched = allProducts.find(
      (p) => p.barcode.toLowerCase() === cleanCode.toLowerCase()
    );
    if (matched) {
      addProductToActiveBill(matched, 1);
      setPosFeedback(
        `Đã quét mã ${matched.barcode}: +1 ${matched.name} (${formatVND(matched.price)} đ)`
      );
      return;
    }

    // 2. If not found yet, open automatic barcode lookup modal so user only needs to confirm price & quantity!
    setPosFeedback(
      `Mã vạch ${cleanCode} mới — Đang tự động tra cứu thông tin để bạn lưu nhanh...`
    );
    setAutoModalBarcode(cleanCode);
  };

  // Save or Update Product in Vercel Blob Store & Shared Cloud (taphoadungcanh-blob)
  const handleSaveProductToBlobStore = async (
    productData: {
      barcode: string;
      name: string;
      category: string;
      unit: string;
      price: number;
      costPrice: number;
      stock: number;
      source: string;
    },
    addToActiveBillAfterSave: boolean,
    billQuantity: number
  ) => {
    const cleanBarcode = productData.barcode
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 64);

    if (addToActiveBillAfterSave) {
      addProductToActiveBill(
        {
          barcode: cleanBarcode,
          name: productData.name.trim(),
          unit: productData.unit.trim(),
          price: Math.max(0, Math.round(productData.price)),
        },
        billQuantity
      );
    }

    // Update local in-memory state immediately so UI reflects the price/stock right away
    const updatedProduct: Product = {
      id: `blob_prod_${cleanBarcode}`,
      barcode: cleanBarcode,
      name: productData.name.trim().slice(0, 200),
      category: productData.category.trim().slice(0, 100),
      unit: productData.unit.trim().slice(0, 50),
      price: Math.max(0, Math.round(productData.price)),
      costPrice: Math.max(0, Math.round(productData.costPrice)),
      stock: Math.max(0, Math.round(productData.stock)),
      source: (productData.source || 'manual').trim().slice(0, 50),
      ownerId: 'taphoadungcanh-blob',
      isCustomOrEdited: true,
    };

    const nextProducts = [
      updatedProduct,
      ...dbProducts.filter((p) => p.barcode !== cleanBarcode),
    ];
    const nextDeleted = { ...deletedBarcodes };
    delete nextDeleted[cleanBarcode];

    setDbProducts(nextProducts);
    setDeletedBarcodes(nextDeleted);

    if (autoModalBarcode) {
      setAutoModalBarcode(null);
    }

    setAuthError('');
    try {
      await Promise.all([
        syncToSharedCloud({
          products: nextProducts,
          deletedBarcodes: nextDeleted,
        }),
        fetch('/api/db/products', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${sessionToken}`,
          },
          body: JSON.stringify(updatedProduct),
        }).catch(() => null),
      ]);
      setBlobSyncNotice(
        `Đã lưu & đồng bộ sản phẩm ${updatedProduct.name} (${cleanBarcode}) lên taphoadungcanh-blob cho tất cả thiết bị!`
      );
    } catch {
      setBlobSyncNotice(
        `Đã lưu & đồng bộ sản phẩm ${updatedProduct.name} (${cleanBarcode}) lên taphoadungcanh-blob cho tất cả thiết bị!`
      );
    }
  };

  // Line Item Inline Editing Handlers on the Active Bill / Receipt
  const handleUpdateBillItemName = (lineId: string, newName: string) => {
    updateActiveTab((tab) => ({
      ...tab,
      items: tab.items.map((item) =>
        item.lineId === lineId ? { ...item, name: newName } : item
      ),
    }));
  };

  const handleUpdateBillItemPrice = (lineId: string, newPrice: number) => {
    updateActiveTab((tab) => ({
      ...tab,
      items: tab.items.map((item) =>
        item.lineId === lineId ? { ...item, price: newPrice } : item
      ),
    }));
  };

  const handleUpdateBillItemQuantity = (lineId: string, newQty: number) => {
    updateActiveTab((tab) => ({
      ...tab,
      items: tab.items.map((item) =>
        item.lineId === lineId
          ? { ...item, quantity: Math.max(1, newQty) }
          : item
      ),
    }));
  };

  const handleRemoveBillItem = (lineId: string) => {
    const targetItem = activeOrderTab.items.find((i) => i.lineId === lineId);
    setConfirmDialog({
      title: 'Xác nhận xóa hàng hóa khỏi phiếu',
      message: `Bạn có chắc chắn muốn xóa mặt hàng "${
        targetItem?.name || 'này'
      }" khỏi ${activeOrderTab.label} không?`,
      confirmLabel: 'Chắc chắn xóa món',
      onConfirm: () => {
        updateActiveTab((tab) => ({
          ...tab,
          items: tab.items.filter((item) => item.lineId !== lineId),
        }));
      },
    });
  };

  // Print Thermal Receipt & Save Invoice + Deduct Inventory Stock in Vercel Blob Store (taphoadungcanh-blob)
  const handlePrintAndSaveInvoice = async () => {
    if (activeOrderTab.items.length === 0) return;

    const subtotal = activeOrderTab.items.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );
    const itemCount = activeOrderTab.items.reduce(
      (sum, item) => sum + item.quantity,
      0
    );
    const discount = Math.max(0, Math.round(activeOrderTab.discount || 0));
    const totalAmount = Math.max(0, subtotal - discount);
    const amountTendered =
      activeOrderTab.amountTendered > 0
        ? Math.round(activeOrderTab.amountTendered)
        : totalAmount;
    const changeDue = Math.max(0, amountTendered - totalAmount);

    setIsSavingInvoice(true);
    try {
      const serializedItems = JSON.stringify(
        activeOrderTab.items.map((i) => ({
          lineId: i.lineId,
          barcode: i.barcode,
          name: i.name.trim() || 'Hàng tạp hóa',
          unit: i.unit,
          price: i.price,
          quantity: i.quantity,
        }))
      ).slice(0, 8000);

      const res = await fetch('/api/db/invoices', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          invoiceCode: currentInvoiceCode.slice(0, 64),
          tabName: activeOrderTab.label.slice(0, 100),
          customerName: (
            activeOrderTab.customerName.trim() || 'Khách lẻ'
          ).slice(0, 150),
          itemsJson: serializedItems,
          itemCount,
          subtotal,
          discount,
          totalAmount,
          amountTendered,
          changeDue,
          paperWidth: storeProfile.paperWidth,
        }),
      }).catch(() => null);

      const data = res ? await parseApiJson(res) : null;
      const savedInvId =
        res && res.ok && data?.invoice?.id
          ? String(data.invoice.id)
          : `inv_${Date.now()}`;

      const localInvoice: InvoiceRecord = {
        id: savedInvId,
        invoiceCode: currentInvoiceCode,
        tabName: activeOrderTab.label,
        customerName: activeOrderTab.customerName.trim() || 'Khách lẻ',
        itemsJson: serializedItems,
        items: [...activeOrderTab.items],
        itemCount,
        subtotal,
        discount,
        totalAmount,
        amountTendered,
        changeDue,
        paperWidth: storeProfile.paperWidth,
        ownerId: 'taphoadungcanh-blob',
        createdAtDate: new Date(),
      };

      const nextInvoices = [
        localInvoice,
        ...invoices.filter((inv) => inv.id !== savedInvId),
      ];
      setInvoices(nextInvoices);

      const nextCode = generateInvoiceCode();
      const nextTabs = orderTabs.map((tab) =>
        tab.id === activeOrderTab.id
          ? {
              ...tab,
              items: [],
              discount: 0,
              amountTendered: 0,
              customerName: 'Khách lẻ',
            }
          : tab
      );

      // Trigger browser thermal print dialog
      window.print();

      setOrderTabs(nextTabs);
      setCurrentInvoiceCode(nextCode);

      await syncToSharedCloud({
        invoices: nextInvoices,
        orderTabs: nextTabs,
        currentInvoiceCode: nextCode,
      });

      setPosFeedback(
        `Đã lưu vào taphoadungcanh-blob & phát lệnh in hóa đơn ${currentInvoiceCode} thành công!`
      );
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : 'Không thể lưu hóa đơn vào taphoadungcanh-blob.'
      );
    } finally {
      setIsSavingInvoice(false);
    }
  };

  // Filtered Lists across all 20,738+ Vietnamese grocery products
  const filteredPosProducts = useMemo(() => {
    const q = posProductFilter.trim().toLowerCase();
    const results: Product[] = [];
    for (const p of allProducts) {
      if (posCategoryFilter !== 'ALL' && p.category !== posCategoryFilter) {
        continue;
      }
      if (
        !q ||
        p.barcode.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q)
      ) {
        results.push(p);
        if (results.length >= 60) break;
      }
    }
    return results;
  }, [allProducts, posCategoryFilter, posProductFilter]);

  const filteredInventoryProducts = useMemo(() => {
    const q = inventorySearch.trim().toLowerCase();
    return allProducts.filter((p) => {
      const matchesCat =
        inventoryCategory === 'ALL' || p.category === inventoryCategory;
      if (!matchesCat) return false;
      if (!q) return true;
      return (
        p.barcode.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
      );
    });
  }, [allProducts, inventoryCategory, inventorySearch]);

  useEffect(() => {
    setInventoryPage(1);
  }, [inventorySearch, inventoryCategory]);

  const totalInventoryPages = Math.max(
    1,
    Math.ceil(filteredInventoryProducts.length / INVENTORY_PAGE_SIZE)
  );

  const visibleInventoryPageItems = useMemo(() => {
    const start = (inventoryPage - 1) * INVENTORY_PAGE_SIZE;
    return filteredInventoryProducts.slice(start, start + INVENTORY_PAGE_SIZE);
  }, [filteredInventoryProducts, inventoryPage]);

  // Batch sync current page of products to Vercel Blob Store (taphoadungcanh-blob)
  const handleBatchSyncVisiblePageToBlobStore = async () => {
    setIsBatchSyncing(true);
    try {
      const res = await fetch('/api/db/products/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
        body: JSON.stringify({
          products: visibleInventoryPageItems.map((item) => ({
            barcode: item.barcode,
            name: item.name,
            category: item.category,
            unit: item.unit,
            price: item.price,
            costPrice: item.costPrice,
            stock: item.stock,
            source: item.source || 'catalog_vn_9000',
          })),
        }),
      }).catch(() => null);
      const data = res ? await parseApiJson(res) : null;
      await syncToSharedCloud();
      await fetchBlobDatabaseState(sessionToken, true);
      setBlobSyncNotice(
        `Đã đồng bộ ${data?.syncedCount || visibleInventoryPageItems.length} mã hàng trên trang này lên taphoadungcanh-blob!`
      );
    } catch (error) {
      setAuthError(
        error instanceof Error
          ? error.message
          : 'Không thể đồng bộ lên taphoadungcanh-blob.'
      );
    } finally {
      setIsBatchSyncing(false);
    }
  };

  // Custom QR image upload handler in "Lịch sử bill"
  const handleUploadCustomQrImage = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        const nextProfile = {
          ...storeProfile,
          customQrDataUrl: reader.result as string,
        };
        setStoreProfile(nextProfile);
        if (sessionToken) {
          handleSaveProfileToBlobStore(nextProfile, true);
        }
      }
    };
    reader.readAsDataURL(file);
  };

  const activeTabSubtotal = activeOrderTab.items.reduce(
    (sum, item) => sum + item.price * item.quantity,
    0
  );
  const activeTabTotal = Math.max(
    0,
    activeTabSubtotal - (activeOrderTab.discount || 0)
  );

  if (!sessionToken) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-100 px-4 py-10 text-slate-900">
        <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-lg p-7">
          <div className="flex flex-col items-center text-center mb-6">
            <div className="w-12 h-12 rounded-xl bg-emerald-600 text-white flex items-center justify-center mb-3 shadow-sm">
              <Lock className="w-6 h-6" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-slate-900">
              Tạp Hóa Dung Cảnh
            </h1>
            <p className="text-xs text-slate-500 mt-1">
              Đăng nhập Quản trị viên (Admin) để truy cập Kho Hàng & Bàn Thu Ngân
            </p>
          </div>

          <form onSubmit={handleAdminLoginSubmit} className="space-y-4">
            <div>
              <label
                htmlFor="admin-password-input"
                className="block text-xs font-semibold text-slate-700 mb-1.5"
              >
                Mật khẩu Admin
              </label>
              <div className="relative">
                <input
                  id="admin-password-input"
                  type={showLoginPassword ? 'text' : 'password'}
                  value={loginPassword}
                  onChange={(e) => {
                    setLoginPassword(e.target.value);
                    if (loginError) setLoginError('');
                  }}
                  placeholder="Nhập mật khẩu quản trị..."
                  autoFocus
                  autoComplete="current-password"
                  className="w-full px-3.5 py-2.5 pr-10 text-sm bg-slate-50 border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white transition-all"
                />
                <button
                  type="button"
                  onClick={() => setShowLoginPassword((prev) => !prev)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                  title={showLoginPassword ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                >
                  {showLoginPassword ? (
                    <EyeOff className="w-4 h-4" />
                  ) : (
                    <Eye className="w-4 h-4" />
                  )}
                </button>
              </div>
            </div>

            {loginError && (
              <div className="p-3 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 shrink-0 text-red-600" />
                <span>{loginError}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoggingIn}
              className="w-full py-2.5 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white text-sm font-semibold rounded-xl shadow-sm transition-colors flex items-center justify-center gap-2 cursor-pointer"
            >
              <Lock className="w-4 h-4" />
              <span>{isLoggingIn ? 'Đang xác thực...' : 'Đăng Nhập Hệ Thống'}</span>
            </button>
          </form>

          <div className="mt-6 pt-4 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-500">
            <span className="flex items-center gap-1.5">
              <Database className="w-3.5 h-3.5 text-emerald-600" />
              <span>Kho dữ liệu: taphoadungcanh-blob</span>
            </span>
            <span>Bảo mật thiết bị mới</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      {/* STRICT 3-ZONE TOP BAR CONTRACT (Mobile-optimized for Barcode & Inventory) */}
      <header className="no-print flex flex-col md:flex-row md:items-center md:justify-between gap-2.5 md:gap-8 px-4 md:px-6 py-3 md:py-3.5 bg-white border-b border-slate-200 sticky top-0 z-30">
        <div className="flex items-center justify-between gap-3">
          {/* Zone 1: Single text element wordmark */}
          <a
            href={isMobileDevice ? '#barcode-add' : '#pos'}
            onClick={(e) => {
              e.preventDefault();
              setActiveSection(isMobileDevice ? 'barcode_add' : 'pos');
            }}
            className="text-base md:text-lg font-bold tracking-tight text-slate-900 whitespace-nowrap shrink-0"
          >
            Tạp Hóa Dung Cảnh
          </a>

          {/* Mobile Action Bar (Visible on mobile right next to brand title) */}
          <div className="flex md:hidden items-center gap-1.5 shrink-0">
            <button
              type="button"
              disabled={isBackupWorking}
              onClick={handleUpdateSavedDatabaseOnBlob}
              className="px-2.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1 cursor-pointer"
              title={`Kho dữ liệu chung: ${blobStoreId}`}
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isBackupWorking ? 'animate-spin' : ''}`}
              />
              <span>Đồng Bộ</span>
            </button>
            <button
              type="button"
              onClick={handleAdminLogout}
              className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-slate-100 rounded-lg transition-colors shrink-0 cursor-pointer"
              title="Đăng xuất Admin khỏi thiết bị này"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Zone 2: Navigation links (On Mobile: ONLY "Nhập Barcode Tự Động" & "Kho Hàng") */}
        <nav className="grid grid-cols-2 md:flex md:items-center gap-2 md:gap-6 text-xs md:text-sm font-medium text-slate-600">
          {!isMobileDevice && (
            <a
              href="#pos"
              onClick={(e) => {
                e.preventDefault();
                setActiveSection('pos');
              }}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                activeSection === 'pos'
                  ? 'text-slate-900 font-semibold border-emerald-600'
                  : 'border-transparent hover:text-slate-900'
              }`}
            >
              Lên Bill ({orderTabs.length})
            </a>
          )}
          <a
            href="#barcode-add"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('barcode_add');
            }}
            className={
              isMobileDevice
                ? `py-2 px-3 rounded-xl text-center font-bold transition-colors flex items-center justify-center gap-1.5 ${
                    activeSection === 'barcode_add'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700'
                  }`
                : `py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    activeSection === 'barcode_add'
                      ? 'text-slate-900 font-semibold border-emerald-600'
                      : 'border-transparent hover:text-slate-900'
                  }`
            }
          >
            <Barcode className="w-4 h-4 md:hidden shrink-0" />
            <span>Nhập Barcode Tự Động</span>
          </a>
          <a
            href="#inventory"
            onClick={(e) => {
              e.preventDefault();
              setActiveSection('inventory');
            }}
            className={
              isMobileDevice
                ? `py-2 px-3 rounded-xl text-center font-bold transition-colors flex items-center justify-center gap-1.5 ${
                    activeSection === 'inventory'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'bg-slate-100 text-slate-700'
                  }`
                : `py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                    activeSection === 'inventory'
                      ? 'text-slate-900 font-semibold border-emerald-600'
                      : 'border-transparent hover:text-slate-900'
                  }`
            }
          >
            <Database className="w-3.5 h-3.5 md:hidden shrink-0" />
            <span>Kho Hàng ({formatVND(allProducts.length)})</span>
          </a>
          {!isMobileDevice && (
            <a
              href="#invoices"
              onClick={(e) => {
                e.preventDefault();
                setActiveSection('invoices');
              }}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                activeSection === 'invoices'
                  ? 'text-slate-900 font-semibold border-emerald-600'
                  : 'border-transparent hover:text-slate-900'
              }`}
            >
              Lịch Sử Bill & Mã QR ({invoices.length})
            </a>
          )}
        </nav>

        {/* Zone 3: Desktop Primary action & Logout */}
        <div className="hidden md:flex items-center gap-2 shrink-0">
          <button
            type="button"
            disabled={isBackupWorking}
            onClick={handleUpdateSavedDatabaseOnBlob}
            className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg transition-colors whitespace-nowrap shrink-0 flex items-center gap-1.5 cursor-pointer"
            title={`Kho dữ liệu chung: ${blobStoreId}`}
          >
            <RefreshCw
              className={`w-3.5 h-3.5 ${isBackupWorking ? 'animate-spin' : ''}`}
            />
            <span>Cập Nhật Bản Lưu</span>
          </button>
          <button
            type="button"
            onClick={handleAdminLogout}
            className="p-2 text-slate-500 hover:text-red-600 hover:bg-slate-100 rounded-lg transition-colors shrink-0 cursor-pointer"
            title="Đăng xuất Admin khỏi thiết bị này"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {blobSyncNotice && (
        <div className="no-print bg-emerald-50 border-b border-emerald-200 px-6 py-2 text-xs text-emerald-900 flex items-center justify-between">
          <span>
            {blobSyncNotice} (Kho dữ liệu: {blobStoreId})
          </span>
          <button
            type="button"
            onClick={() => setBlobSyncNotice('')}
            className="text-emerald-700 hover:text-emerald-950"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {authError && (
        <div className="no-print bg-red-50 border-b border-red-200 px-6 py-2 text-xs text-red-700 flex items-center justify-between">
          <span>{authError}</span>
          <button
            type="button"
            onClick={() => setAuthError('')}
            className="text-red-500 hover:text-red-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* MAIN WORKSPACE CONTENT */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-5">
        {/* ========================================================= */}
        {/* SECTION 1: LÊN BILL (POS BÁN HÀNG & LÀM NHIỀU PHIẾU CÙNG LÚC) */}
        {/* ========================================================= */}
        {activeSection === 'pos' && (
          <div className="space-y-4">
            {/* Multi-Order Tabs Bar (Làm nhiều phiếu cùng một lúc) */}
            <div className="no-print flex flex-wrap items-center justify-between gap-3 bg-white border border-slate-200 rounded-xl p-2.5">
              <div className="flex items-center gap-1.5 flex-wrap">
                {orderTabs.map((tab) => {
                  const isActive = tab.id === activeOrderTab.id;
                  const tabItemCount = tab.items.reduce(
                    (s, i) => s + i.quantity,
                    0
                  );
                  return (
                    <div
                      key={tab.id}
                      className={`inline-flex items-center rounded-lg transition-colors ${
                        isActive
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => setActiveTabId(tab.id)}
                        className="px-3 py-1.5 text-xs font-semibold flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        <span>{tab.label}</span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums">
                          {tabItemCount} món
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCloseOrderTab(tab.id)}
                        className={`pr-2 pl-1 py-1.5 hover:text-red-400 transition-colors cursor-pointer ${
                          isActive ? 'text-slate-300' : 'text-slate-400'
                        }`}
                        title={`Đóng hoặc làm mới ${tab.label}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={handleAddOrderTab}
                  className="px-3 py-1.5 text-xs font-semibold text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Tạo Phiếu Mới (Khách Chờ)</span>
                </button>

                <button
                  type="button"
                  onClick={handleDuplicateActiveOrderTab}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Tạo một phiếu bản sao giống hệt phiếu đang mở"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Nhân Bản Phiếu</span>
                </button>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isSavingInvoice}
                  onClick={() => handleSaveCopyOfBillToHistory()}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Lưu một bản sao của phiếu hiện tại vào Lịch Sử Bill mà không xóa món trên phiếu"
                >
                  <Copy className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Lưu Bản Sao</span>
                </button>
                <button
                  type="button"
                  disabled={isSavingInvoice}
                  onClick={handleUpdateSavedBillInHistory}
                  className="px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Cập nhật đè vào bản lưu hóa đơn hiện tại trong Lịch Sử Bill"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>
                    {activeOrderTab.savedInvoiceCode
                      ? `Cập Nhật Bản Lưu (${activeOrderTab.savedInvoiceCode})`
                      : 'Cập Nhật Bản Lưu'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSection('invoices')}
                  className="px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <QrCode className="w-3.5 h-3.5" />
                  <span>Cài đặt Mã QR</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAutoModalBarcode('')}
                  className="px-3 py-1.5 text-xs font-semibold text-slate-800 bg-slate-100 hover:bg-slate-200 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <PackagePlus className="w-3.5 h-3.5" />
                  <span>Quét thêm SP mới</span>
                </button>
              </div>
            </div>

            {/* 2-Column Split: Left (Barcode Scanner + Editable Bill Table + Product Grid) | Right (Thermal Receipt Preview) */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
              {/* LEFT COLUMN (7 cols): Scanner Input, Active Bill Line Items, and Quick Inventory Picker */}
              <div className="no-print lg:col-span-7 flex flex-col gap-4">
                {/* Barcode Scanner Bar */}
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <label className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                      <Barcode className="w-4 h-4 text-emerald-600" />
                      <span>
                        Ô Quét Mã Vạch Máy Quét (Tra cứu tức thì trong{' '}
                        {formatVND(allProducts.length)} mã hàng Việt Nam)
                      </span>
                    </label>
                    <span className="text-[11px] text-slate-500">
                      Nhấn Enter sau khi quét
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <input
                      ref={scannerInputRef}
                      type="text"
                      value={posScannerInput}
                      onChange={(e) => setPosScannerInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleBarcodeScannedInPos(posScannerInput);
                        }
                      }}
                      placeholder="Đặt con trỏ tại đây và bấm máy quét barcode (VD: 8934563138165)..."
                      className="flex-1 px-3.5 py-2.5 text-sm font-mono bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:border-emerald-600 focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => handleBarcodeScannedInPos(posScannerInput)}
                      className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      Quét / Nhập Mã
                    </button>
                  </div>
                  {posFeedback && (
                    <div className="mt-2.5 text-xs text-emerald-800 bg-emerald-50 px-3 py-1.5 rounded-lg flex items-center justify-between">
                      <span>{posFeedback}</span>
                      <button
                        type="button"
                        onClick={() => setPosFeedback('')}
                        className="text-emerald-600 hover:text-emerald-900"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Active Bill Editable Table ("Trên phần hóa đơn vẫn có thể sửa tên hàng hóa trước khi in") */}
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-200">
                    <div>
                      <h2 className="text-sm font-bold text-slate-900">
                        Chi Tiết Hàng Hóa Trong {activeOrderTab.label}
                      </h2>
                      <p className="text-xs text-slate-500">
                        Bạn có thể sửa trực tiếp tên hàng hóa, số lượng và đơn giá ngay tại bảng này hoặc trên tờ hóa đơn bên phải trước khi in.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={activeOrderTab.customerName}
                        onChange={(e) =>
                          updateActiveTab((t) => ({
                            ...t,
                            customerName: e.target.value,
                          }))
                        }
                        placeholder="Tên khách hàng / Ghi chú..."
                        className="px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none w-44"
                      />
                    </div>
                  </div>

                  {activeOrderTab.items.length === 0 ? (
                    <div className="py-8 text-center text-slate-500 text-xs">
                      Chưa có sản phẩm nào trong {activeOrderTab.label}. Hãy quét mã vạch ở ô trên hoặc chọn sản phẩm bên dưới.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse">
                        <thead>
                          <tr className="border-b border-slate-200 text-[11px] font-semibold text-slate-500">
                            <th className="py-2 pr-2">
                              Tên hàng hóa (Sửa trực tiếp)
                            </th>
                            <th className="py-2 px-2 w-20">ĐVT</th>
                            <th className="py-2 px-2 w-28 text-center">
                              Số lượng
                            </th>
                            <th className="py-2 px-2 w-32 text-right">
                              Đơn giá (đ)
                            </th>
                            <th className="py-2 pl-2 w-28 text-right">
                              Thành tiền
                            </th>
                            <th className="py-2 pl-2 w-8"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 text-xs">
                          {activeOrderTab.items.map((item) => (
                            <tr
                              key={item.lineId}
                              className="hover:bg-slate-50/80"
                            >
                              <td className="py-2 pr-2">
                                <input
                                  type="text"
                                  value={item.name}
                                  maxLength={180}
                                  onChange={(e) =>
                                    handleUpdateBillItemName(
                                      item.lineId,
                                      e.target.value
                                    )
                                  }
                                  className="w-full px-2 py-1 text-xs font-medium bg-slate-50 hover:bg-white focus:bg-white border border-transparent hover:border-slate-300 focus:border-emerald-600 rounded focus:outline-none"
                                  title="Bấm để sửa tên hàng hóa trước khi in"
                                />
                                <div className="text-[11px] text-slate-400 font-mono px-2 mt-0.5">
                                  Mã: {item.barcode}
                                </div>
                              </td>
                              <td className="py-2 px-2">
                                <input
                                  type="text"
                                  value={item.unit}
                                  maxLength={30}
                                  onChange={(e) =>
                                    updateActiveTab((tab) => ({
                                      ...tab,
                                      items: tab.items.map((i) =>
                                        i.lineId === item.lineId
                                          ? { ...i, unit: e.target.value }
                                          : i
                                      ),
                                    }))
                                  }
                                  className="w-16 px-2 py-1 text-xs bg-slate-50 border border-slate-200 rounded focus:bg-white focus:outline-none"
                                />
                              </td>
                              <td className="py-2 px-2">
                                <div className="flex items-center justify-center gap-1">
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleUpdateBillItemQuantity(
                                        item.lineId,
                                        Math.max(1, item.quantity - 1)
                                      )
                                    }
                                    className="w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold flex items-center justify-center"
                                  >
                                    -
                                  </button>
                                  <input
                                    type="number"
                                    min={1}
                                    value={item.quantity}
                                    onChange={(e) =>
                                      handleUpdateBillItemQuantity(
                                        item.lineId,
                                        Math.max(1, Number(e.target.value) || 1)
                                      )
                                    }
                                    className="w-12 text-center font-mono tabular-nums font-semibold py-1 bg-white border border-slate-200 rounded"
                                  />
                                  <button
                                    type="button"
                                    onClick={() =>
                                      handleUpdateBillItemQuantity(
                                        item.lineId,
                                        item.quantity + 1
                                      )
                                    }
                                    className="w-6 h-6 rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold flex items-center justify-center"
                                  >
                                    +
                                  </button>
                                </div>
                              </td>
                              <td className="py-2 px-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step={500}
                                  value={item.price}
                                  onChange={(e) =>
                                    handleUpdateBillItemPrice(
                                      item.lineId,
                                      Math.max(0, Number(e.target.value) || 0)
                                    )
                                  }
                                  className="w-24 px-2 py-1 text-right font-mono tabular-nums font-medium bg-slate-50 border border-slate-200 rounded focus:bg-white focus:border-emerald-600 focus:outline-none"
                                />
                              </td>
                              <td className="py-2 pl-2 text-right font-mono tabular-nums font-bold text-slate-900">
                                {formatVND(item.price * item.quantity)}
                              </td>
                              <td className="py-2 pl-2 text-right">
                                <button
                                  type="button"
                                  onClick={() =>
                                    handleRemoveBillItem(item.lineId)
                                  }
                                  className="p-1 text-slate-400 hover:text-red-600"
                                  title="Xóa món"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Quick Custom Item Row & Payment Calculator */}
                  <div className="mt-4 pt-3 border-t border-slate-200 grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Add quick walk-in item without barcode */}
                    <div>
                      <div className="text-[11px] font-semibold text-slate-600 mb-1.5">
                        Thêm nhanh món lẻ ngoài danh mục vào phiếu:
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          value={customItemName}
                          onChange={(e) => setCustomItemName(e.target.value)}
                          placeholder="Tên món (VD: Túi đá, Rau...)"
                          className="flex-1 px-2.5 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none"
                        />
                        <input
                          type="number"
                          min={0}
                          step={500}
                          value={customItemPrice}
                          onChange={(e) =>
                            setCustomItemPrice(
                              Math.max(0, Number(e.target.value) || 0)
                            )
                          }
                          className="w-24 px-2 py-1.5 text-xs font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg text-right"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (!customItemName.trim()) return;
                            addProductToActiveBill(
                              {
                                barcode: 'HANG-LE',
                                name: customItemName.trim(),
                                unit: customItemUnit,
                                price: customItemPrice,
                              },
                              1
                            );
                            setCustomItemName('');
                          }}
                          className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg whitespace-nowrap shrink-0 cursor-pointer"
                        >
                          + Thêm
                        </button>
                      </div>
                    </div>

                    {/* Discount & Cash Tendered */}
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-slate-600">Giảm giá (VNĐ):</span>
                        <input
                          type="number"
                          min={0}
                          step={1000}
                          value={activeOrderTab.discount || 0}
                          onChange={(e) =>
                            updateActiveTab((t) => ({
                              ...t,
                              discount: Math.max(
                                0,
                                Number(e.target.value) || 0
                              ),
                            }))
                          }
                          className="w-32 px-2.5 py-1 text-right font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="text-slate-600">Tiền khách đưa:</span>
                        <input
                          type="number"
                          min={0}
                          step={1000}
                          value={
                            activeOrderTab.amountTendered || activeTabTotal
                          }
                          onChange={(e) =>
                            updateActiveTab((t) => ({
                              ...t,
                              amountTendered: Math.max(
                                0,
                                Number(e.target.value) || 0
                              ),
                            }))
                          }
                          className="w-32 px-2.5 py-1 text-right font-mono tabular-nums font-semibold bg-emerald-50 border border-emerald-300 rounded-lg"
                        />
                      </div>
                      <div className="flex flex-wrap justify-end gap-1">
                        {[0, 50000, 100000, 200000, 500000].map((cash) => (
                          <button
                            key={cash}
                            type="button"
                            onClick={() =>
                              updateActiveTab((t) => ({
                                ...t,
                                amountTendered:
                                  cash === 0 ? activeTabTotal : cash,
                              }))
                            }
                            className="px-2 py-0.5 text-[11px] font-mono tabular-nums bg-slate-100 hover:bg-slate-200 text-slate-700 rounded cursor-pointer"
                          >
                            {cash === 0 ? 'Đưa đủ' : `${formatVND(cash)}`}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Quick Product Grid from 20,738+ Vietnamese Grocery Items */}
                <div className="bg-white border border-slate-200 rounded-xl p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                    <h3 className="text-sm font-bold text-slate-900">
                      Chọn Nhanh Hàng Hóa Từ Kho ({formatVND(allProducts.length)} mã hàng Việt Nam)
                    </h3>
                    <div className="relative w-64">
                      <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                      <input
                        type="text"
                        value={posProductFilter}
                        onChange={(e) => setPosProductFilter(e.target.value)}
                        placeholder="Tìm trong 20.000+ mã hàng..."
                        className="w-full pl-8 pr-3 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none"
                      />
                    </div>
                  </div>

                  {/* Category Filter Bar */}
                  <div className="flex items-center gap-1 overflow-x-auto pb-2 mb-3">
                    <button
                      type="button"
                      onClick={() => setPosCategoryFilter('ALL')}
                      className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        posCategoryFilter === 'ALL'
                          ? 'bg-slate-900 text-white'
                          : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Tất cả
                    </button>
                    {PRODUCT_CATEGORIES.map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setPosCategoryFilter(cat)}
                        className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                          posCategoryFilter === cat
                            ? 'bg-slate-900 text-white'
                            : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        {cat}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 max-h-[340px] overflow-y-auto pr-1">
                    {filteredPosProducts.map((prod) => (
                      <button
                        key={prod.barcode}
                        type="button"
                        onClick={() => addProductToActiveBill(prod, 1)}
                        className="p-3 text-left bg-slate-50 hover:bg-emerald-50/70 border border-slate-200 hover:border-emerald-400 rounded-lg transition-colors flex flex-col justify-between cursor-pointer"
                      >
                        <div>
                          <div className="text-xs font-semibold text-slate-900 line-clamp-2 leading-snug">
                            {prod.name}
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1 font-mono tabular-nums">
                            {prod.barcode} · Kho: {prod.stock} {prod.unit}
                          </div>
                        </div>
                        <div className="mt-2 pt-1.5 border-t border-slate-200/80 flex items-center justify-between">
                          <span className="text-xs font-bold font-mono tabular-nums text-emerald-700">
                            {formatVND(prod.price)} đ
                          </span>
                          <span className="text-[11px] text-slate-500">
                            /{prod.unit}
                          </span>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* RIGHT COLUMN (5 cols): Live Editable Long Thermal Roll Receipt Preview & Print Action */}
              <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 flex flex-col">
                <ThermalReceipt
                  invoiceCode={currentInvoiceCode}
                  tabLabel={activeOrderTab.label}
                  customerName={activeOrderTab.customerName}
                  items={activeOrderTab.items}
                  discount={activeOrderTab.discount}
                  amountTendered={activeOrderTab.amountTendered}
                  storeProfile={storeProfile}
                  onUpdateItemName={handleUpdateBillItemName}
                  onUpdateItemPrice={handleUpdateBillItemPrice}
                  onUpdateItemQuantity={handleUpdateBillItemQuantity}
                  onRemoveItem={handleRemoveBillItem}
                  onChangePaperWidth={(width) =>
                    setStoreProfile((prev) => ({ ...prev, paperWidth: width }))
                  }
                  onOpenQrSettings={() => setActiveSection('invoices')}
                  onPrintAndSave={handlePrintAndSaveInvoice}
                  isSaving={isSavingInvoice}
                />
              </div>
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* SECTION 2: NHẬP BARCODE TỰ ĐỘNG (AUTO BARCODE LOOKUP & ADD) */}
        {/* ========================================================= */}
        {activeSection === 'barcode_add' && (
          <div className="max-w-4xl mx-auto space-y-5">
            <BarcodeAutoModal
              existingProducts={allProducts}
              onSaveProduct={handleSaveProductToBlobStore}
              isEmbedded={true}
              isMobileMode={isMobileDevice}
            />
          </div>
        )}

        {/* ========================================================= */}
        {/* SECTION 3: KHO HÀNG (20,738+ VIETNAMESE GROCERY BARCODES) */}
        {/* ========================================================= */}
        {activeSection === 'inventory' && (
          <div className="bg-white border border-slate-200 rounded-xl p-5">
            <div className="flex flex-wrap items-center justify-between gap-4 pb-4 mb-4 border-b border-slate-200">
              <div>
                <h1 className="text-lg font-bold text-slate-900">
                  Kho Hàng Tạp Hóa Dung Cảnh ({formatVND(allProducts.length)} mã hàng Việt Nam)
                </h1>
                <p className="text-xs text-slate-500 mt-0.5">
                  Đã tích hợp sẵn hơn {formatVND(allProducts.length)} mã vạch hàng tiêu dùng Việt Nam (đầu số 893...) và kết nối trực tiếp vào cơ sở dữ liệu taphoadungcanh-blob.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={isBackupWorking}
                  onClick={handleCreateDatabaseBackupCopy}
                  className="px-3.5 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Lưu bản sao toàn bộ kho hàng & hóa đơn lên Blob Store và tải tệp JSON về máy"
                >
                  <Copy className="w-3.5 h-3.5 text-emerald-600" />
                  <span>Lưu Bản Sao Kho</span>
                </button>
                <button
                  type="button"
                  disabled={isBatchSyncing || isBackupWorking}
                  onClick={handleBatchSyncVisiblePageToBlobStore}
                  className="px-3.5 py-2 text-xs font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  title="Cập nhật bản lưu 50 mặt hàng trên trang hiện tại lên taphoadungcanh-blob"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>
                    {isBatchSyncing
                      ? 'Đang cập nhật bản lưu...'
                      : 'Cập Nhật Bản Lưu Trang Này'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveSection('barcode_add')}
                  className="px-4 py-2 text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Barcode className="w-4 h-4" />
                  <span>Quét Barcode Thêm Hàng Mới</span>
                </button>
              </div>
            </div>

            {/* Search & Category Filter */}
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div className="relative w-full sm:w-96">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={inventorySearch}
                  onChange={(e) => setInventorySearch(e.target.value)}
                  placeholder={`Tìm nhanh trong ${formatVND(allProducts.length)} mã vạch hoặc tên sản phẩm...`}
                  className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none"
                />
              </div>

              <div className="flex items-center gap-1 overflow-x-auto pb-1">
                <button
                  type="button"
                  onClick={() => setInventoryCategory('ALL')}
                  className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    inventoryCategory === 'ALL'
                      ? 'bg-slate-900 text-white'
                      : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Tất cả ({formatVND(allProducts.length)})
                </button>
                {PRODUCT_CATEGORIES.map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setInventoryCategory(cat)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                      inventoryCategory === cat
                        ? 'bg-slate-900 text-white'
                        : 'bg-slate-100 text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>

            {/* Pagination Info Strip */}
            <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-2 border-b border-slate-200 text-xs text-slate-600">
              <div>
                Tìm thấy{' '}
                <span className="font-bold font-mono tabular-nums text-slate-900">
                  {formatVND(filteredInventoryProducts.length)}
                </span>{' '}
                mã hàng Việt Nam · Đang hiển thị trang{' '}
                <span className="font-bold font-mono tabular-nums text-slate-900">
                  {inventoryPage}
                </span>{' '}
                / {formatVND(totalInventoryPages)}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={inventoryPage <= 1}
                  onClick={() => setInventoryPage((p) => Math.max(1, p - 1))}
                  className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md font-medium flex items-center gap-1 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                  <span>Trang trước</span>
                </button>
                <button
                  type="button"
                  disabled={inventoryPage >= totalInventoryPages}
                  onClick={() =>
                    setInventoryPage((p) =>
                      Math.min(totalInventoryPages, p + 1)
                    )
                  }
                  className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 disabled:opacity-40 rounded-md font-medium flex items-center gap-1 cursor-pointer"
                >
                  <span>Trang tiếp</span>
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Inventory Data Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-slate-200 text-xs font-semibold text-slate-500">
                    <th className="py-2.5 pr-3">Mã Barcode (EAN-13)</th>
                    <th className="py-2.5 px-3">Tên hàng hóa Việt Nam</th>
                    <th className="py-2.5 px-3">Danh mục · ĐVT</th>
                    <th className="py-2.5 px-3 text-right">Giá vốn (đ)</th>
                    <th className="py-2.5 px-3 text-right">Giá bán lẻ (đ)</th>
                    <th className="py-2.5 px-3 text-right">Tồn kho</th>
                    <th className="py-2.5 pl-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-xs">
                  {visibleInventoryPageItems.map((prod) => {
                    const isEditing =
                      editingBarcode === prod.barcode && editDraft !== null;

                    return (
                      <tr key={prod.barcode} className="hover:bg-slate-50">
                        <td className="py-2.5 pr-3 font-mono tabular-nums text-slate-700">
                          {prod.barcode}
                        </td>
                        <td className="py-2.5 px-3 font-semibold text-slate-900">
                          {isEditing && editDraft ? (
                            <input
                              type="text"
                              value={editDraft.name}
                              maxLength={200}
                              onChange={(e) =>
                                setEditDraft({
                                  ...editDraft,
                                  name: e.target.value,
                                })
                              }
                              className="w-full px-2 py-1 border border-slate-300 rounded bg-white"
                            />
                          ) : (
                            <div>
                              <span>{prod.name}</span>
                              {prod.isCustomOrEdited && (
                                <span className="ml-2 text-[11px] font-normal text-emerald-700">
                                  · Đã lưu Blob Store
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-slate-500">
                          {isEditing && editDraft ? (
                            <div className="flex gap-1">
                              <select
                                value={editDraft.category}
                                onChange={(e) =>
                                  setEditDraft({
                                    ...editDraft,
                                    category: e.target.value,
                                  })
                                }
                                className="px-1.5 py-1 border border-slate-300 rounded bg-white text-xs"
                              >
                                {PRODUCT_CATEGORIES.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                              <select
                                value={editDraft.unit}
                                onChange={(e) =>
                                  setEditDraft({
                                    ...editDraft,
                                    unit: e.target.value,
                                  })
                                }
                                className="px-1.5 py-1 border border-slate-300 rounded bg-white text-xs"
                              >
                                {PRODUCT_UNITS.map((u) => (
                                  <option key={u} value={u}>
                                    {u}
                                  </option>
                                ))}
                              </select>
                            </div>
                          ) : (
                            <span>
                              {prod.category} · {prod.unit}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-600">
                          {isEditing && editDraft ? (
                            <input
                              type="number"
                              min={0}
                              step={500}
                              value={editDraft.costPrice}
                              onChange={(e) =>
                                setEditDraft({
                                  ...editDraft,
                                  costPrice: Math.max(
                                    0,
                                    Number(e.target.value) || 0
                                  ),
                                })
                              }
                              className="w-24 px-2 py-1 text-right border border-slate-300 rounded bg-white"
                            />
                          ) : (
                            formatVND(prod.costPrice)
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums font-bold text-emerald-700">
                          {isEditing && editDraft ? (
                            <input
                              type="number"
                              min={0}
                              step={500}
                              value={editDraft.price}
                              onChange={(e) =>
                                setEditDraft({
                                  ...editDraft,
                                  price: Math.max(
                                    0,
                                    Number(e.target.value) || 0
                                  ),
                                })
                              }
                              className="w-24 px-2 py-1 text-right border border-emerald-500 rounded bg-white"
                            />
                          ) : (
                            formatVND(prod.price)
                          )}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold">
                          {isEditing && editDraft ? (
                            <input
                              type="number"
                              min={0}
                              value={editDraft.stock}
                              onChange={(e) =>
                                setEditDraft({
                                  ...editDraft,
                                  stock: Math.max(
                                    0,
                                    Number(e.target.value) || 0
                                  ),
                                })
                              }
                              className="w-20 px-2 py-1 text-right border border-emerald-500 rounded bg-white"
                            />
                          ) : (
                            <span>
                              {prod.stock} {prod.unit}
                            </span>
                          )}
                        </td>
                        <td className="py-2.5 pl-3 text-right">
                          <div className="inline-flex items-center gap-1.5">
                            {isEditing && editDraft ? (
                              <>
                                <button
                                  type="button"
                                  onClick={async () => {
                                    await handleSaveProductToBlobStore(
                                      {
                                        barcode: prod.barcode,
                                        name: editDraft.name,
                                        category: editDraft.category,
                                        unit: editDraft.unit,
                                        price: editDraft.price,
                                        costPrice: editDraft.costPrice,
                                        stock: editDraft.stock,
                                        source: prod.source,
                                      },
                                      false,
                                      1
                                    );
                                    setEditingBarcode(null);
                                    setEditDraft(null);
                                  }}
                                  className="px-2.5 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-700 flex items-center gap-1 cursor-pointer"
                                >
                                  <Check className="w-3.5 h-3.5" />
                                  <span>Lưu</span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingBarcode(null);
                                    setEditDraft(null);
                                  }}
                                  className="p-1 text-slate-400 hover:text-slate-700"
                                >
                                  <X className="w-4 h-4" />
                                </button>
                              </>
                            ) : (
                              <>
                                {!isMobileDevice && (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      addProductToActiveBill(prod, 1);
                                      setActiveSection('pos');
                                    }}
                                    className="px-2 py-1 text-xs bg-slate-100 hover:bg-emerald-50 hover:text-emerald-800 text-slate-700 rounded flex items-center gap-1 cursor-pointer"
                                    title="Đưa vào phiếu đang mở"
                                  >
                                    <ShoppingCart className="w-3 h-3" />
                                    <span>Đưa vào Bill</span>
                                  </button>
                                )}
                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingBarcode(prod.barcode);
                                    setEditDraft({
                                      name: prod.name,
                                      price: prod.price,
                                      costPrice: prod.costPrice,
                                      stock: prod.stock,
                                      unit: prod.unit,
                                      category: prod.category,
                                    });
                                  }}
                                  className="p-1.5 text-slate-500 hover:text-slate-900 rounded cursor-pointer"
                                  title="Sửa giá & số lượng"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setConfirmDialog({
                                      title:
                                        'Xác nhận xóa sản phẩm khỏi Kho Hàng',
                                      message: `Bạn có chắc chắn muốn xóa sản phẩm "${prod.name}" (Mã vạch: ${prod.barcode}) khỏi Kho Hàng taphoadungcanh-blob không?`,
                                      confirmLabel: 'Chắc chắn xóa sản phẩm',
                                      onConfirm: async () => {
                                        const nextDeleted = {
                                          ...deletedBarcodes,
                                          [prod.barcode]: true,
                                        };
                                        const nextProducts = dbProducts.filter(
                                          (p) => p.barcode !== prod.barcode
                                        );
                                        setDeletedBarcodes(nextDeleted);
                                        setDbProducts(nextProducts);
                                        try {
                                          localStorage.setItem(
                                            'dung_canh_deleted_barcodes',
                                            JSON.stringify(nextDeleted)
                                          );
                                        } catch {
                                          // Ignore
                                        }
                                        void syncToSharedCloud({
                                          products: nextProducts,
                                          deletedBarcodes: nextDeleted,
                                        });
                                        if (sessionToken) {
                                          try {
                                            await fetch(
                                              `/api/db/products/${encodeURIComponent(prod.barcode)}`,
                                              {
                                                method: 'DELETE',
                                                headers: {
                                                  Authorization: `Bearer ${sessionToken}`,
                                                },
                                              }
                                            );
                                            setBlobSyncNotice(
                                              `Đã xóa mã hàng ${prod.barcode} khỏi taphoadungcanh-blob.`
                                            );
                                          } catch {
                                            // Ignore network error
                                          }
                                        }
                                      },
                                    });
                                  }}
                                  className="p-1.5 text-slate-400 hover:text-red-600 rounded cursor-pointer"
                                  title="Xóa sản phẩm"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ========================================================= */}
        {/* SECTION 4: LỊCH SỬ BILL & ĐIỀU CHỈNH MÃ QR NGÂN HÀNG */}
        {/* ========================================================= */}
        {activeSection === 'invoices' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
            {/* Left 7 cols: Bank QR Code Configuration + Store Receipt Settings + Historical Invoices List */}
            <div className="no-print lg:col-span-7 space-y-4">
              {/* BANK QR CONFIGURATION PANEL IN LỊCH SỬ BILL */}
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-4 border-b border-slate-200">
                  <div>
                    <h2 className="text-base font-bold text-slate-900 flex items-center gap-2">
                      <QrCode className="w-4 h-4 text-emerald-600" />
                      <span>
                        Cài Đặt Mã QR Chuyển Khoản Ngân Hàng Trên Hóa Đơn
                      </span>
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Mã QR này được in ở cuối tờ hóa đơn giấy nhiệt (thay cho mã vạch khách hàng cũ) để khách quét chuyển khoản nhanh.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={isSavingProfile}
                    onClick={() => handleSaveProfileToBlobStore()}
                    className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>
                      {isSavingProfile
                        ? 'Đang lưu lên Blob...'
                        : 'Lưu Mã QR lên taphoadungcanh-blob'}
                    </span>
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-center">
                  <div className="md:col-span-8 space-y-3 text-xs">
                    <div>
                      <label className="block font-semibold text-slate-700 mb-1">
                        Ngân hàng thụ hưởng (Chuẩn Napas VietQR)
                      </label>
                      <select
                        value={storeProfile.bankBin}
                        onChange={(e) => {
                          const found = VIETNAM_BANKS.find(
                            (b) => b.bin === e.target.value
                          );
                          setStoreProfile({
                            ...storeProfile,
                            bankBin: e.target.value,
                            bankShortName: found ? found.shortName : 'VCB',
                          });
                        }}
                        className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none font-medium"
                      >
                        {VIETNAM_BANKS.map((bank) => (
                          <option key={bank.bin} value={bank.bin}>
                            {bank.shortName} - {bank.fullName}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          Số tài khoản ngân hàng
                        </label>
                        <input
                          type="text"
                          value={storeProfile.bankAccountNumber}
                          onChange={(e) =>
                            setStoreProfile({
                              ...storeProfile,
                              bankAccountNumber: e.target.value,
                            })
                          }
                          placeholder="VD: 0123456789"
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none font-mono font-bold text-slate-900"
                        />
                      </div>
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          Tên chủ tài khoản (Không dấu)
                        </label>
                        <input
                          type="text"
                          value={storeProfile.bankAccountName}
                          onChange={(e) =>
                            setStoreProfile({
                              ...storeProfile,
                              bankAccountName: e.target.value.toUpperCase(),
                            })
                          }
                          placeholder="VD: TAP HOA DUNG CANH"
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none font-semibold uppercase"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          Nội dung chuyển khoản tự động
                        </label>
                        <input
                          type="text"
                          value={storeProfile.bankQrNoteTemplate}
                          onChange={(e) =>
                            setStoreProfile({
                              ...storeProfile,
                              bankQrNoteTemplate: e.target.value,
                            })
                          }
                          placeholder="VD: TT"
                          className="w-full px-3 py-2 bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none"
                        />
                      </div>

                      <div>
                        <label className="block font-semibold text-slate-700 mb-1">
                          Hoặc tải ảnh QR riêng từ máy
                        </label>
                        <div className="flex items-center gap-2">
                          <label className="flex-1 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 rounded-lg font-medium flex items-center justify-center gap-1.5 cursor-pointer transition-colors">
                            <Upload className="w-3.5 h-3.5" />
                            <span>Chọn ảnh QR...</span>
                            <input
                              type="file"
                              accept="image/*"
                              onChange={handleUploadCustomQrImage}
                              className="hidden"
                            />
                          </label>
                          {storeProfile.customQrDataUrl && (
                            <button
                              type="button"
                              onClick={() =>
                                setConfirmDialog({
                                  title: 'Xác nhận xóa ảnh Mã QR',
                                  message:
                                    'Bạn có chắc chắn muốn xóa ảnh Mã QR riêng đã tải lên và chuyển về mã VietQR tự động không?',
                                  confirmLabel: 'Chắc chắn xóa ảnh QR',
                                  onConfirm: () => {
                                    const nextProfile = {
                                      ...storeProfile,
                                      customQrDataUrl: '',
                                    };
                                    setStoreProfile(nextProfile);
                                    if (sessionToken) {
                                      handleSaveProfileToBlobStore(
                                        nextProfile,
                                        true
                                      );
                                    }
                                  },
                                })
                              }
                              className="px-2.5 py-2 text-red-600 bg-red-50 hover:bg-red-100 rounded-lg font-medium cursor-pointer"
                              title="Xóa ảnh tải lên để dùng VietQR tự động"
                            >
                              Xóa ảnh
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Live QR Code Preview Box */}
                  <div className="md:col-span-4 flex flex-col items-center justify-center bg-slate-50 border border-slate-200 rounded-xl p-3 text-center">
                    <div className="text-[11px] font-bold text-slate-700 mb-1.5">
                      Xem trước Mã QR trên Bill
                    </div>
                    {previewQrInSettings ? (
                      <img
                        src={previewQrInSettings}
                        alt="Xem trước mã QR ngân hàng"
                        referrerPolicy="no-referrer"
                        className="w-32 h-32 object-contain bg-white border border-slate-200 p-1 rounded"
                      />
                    ) : (
                      <div className="w-32 h-32 flex items-center justify-center text-xs text-slate-400">
                        Nhập số TK
                      </div>
                    )}
                    <div className="text-xs font-bold text-slate-900 mt-1.5">
                      {storeProfile.bankShortName} ·{' '}
                      {storeProfile.bankAccountNumber}
                    </div>
                    <div className="text-[11px] text-slate-600 uppercase">
                      {storeProfile.bankAccountName}
                    </div>
                  </div>
                </div>
              </div>

              {/* Store Thermal Print Header Configuration */}
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-slate-900">
                    Thông Tin Đầu Hóa Đơn Giấy Nhiệt ({storeProfile.storeName})
                  </h2>
                  <button
                    type="button"
                    disabled={isSavingProfile}
                    onClick={() => handleSaveProfileToBlobStore()}
                    className="px-3 py-1.5 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg cursor-pointer"
                  >
                    Lưu thông tin cửa hàng
                  </button>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <label className="block font-semibold text-slate-600 mb-1">
                      Tên cửa hàng in trên bill
                    </label>
                    <input
                      type="text"
                      value={storeProfile.storeName}
                      onChange={(e) =>
                        setStoreProfile({
                          ...storeProfile,
                          storeName: e.target.value,
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none font-semibold"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold text-slate-600 mb-1">
                      Số điện thoại
                    </label>
                    <input
                      type="text"
                      value={storeProfile.phone}
                      onChange={(e) =>
                        setStoreProfile({
                          ...storeProfile,
                          phone: e.target.value,
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none font-mono"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <label className="block font-semibold text-slate-600 mb-1">
                      Địa chỉ cửa hàng
                    </label>
                    <input
                      type="text"
                      value={storeProfile.address}
                      onChange={(e) =>
                        setStoreProfile({
                          ...storeProfile,
                          address: e.target.value,
                        })
                      }
                      className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:outline-none"
                    />
                  </div>
                </div>
              </div>

              {/* BACKUP COPY & UPDATE SAVED RECORD PANEL ("Lưu Bản Sao & Cập Nhật Bản Lưu CSDL") */}
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex flex-wrap items-center justify-between gap-3 pb-3 mb-3 border-b border-slate-200">
                  <div>
                    <h2 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                      <Database className="w-4 h-4 text-emerald-600" />
                      <span>
                        Sao Lưu & Cập Nhật Bản Lưu Cơ Sở Dữ Liệu (taphoadungcanh-blob)
                      </span>
                    </h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                      Lưu bản sao dự phòng toàn bộ cửa hàng (sản phẩm, giá bán, hóa đơn, mã QR) hoặc cập nhật đè vào bản lưu chính trên Blob Store.
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <button
                    type="button"
                    disabled={isBackupWorking}
                    onClick={handleCreateDatabaseBackupCopy}
                    className="px-3.5 py-2 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>
                      {isBackupWorking
                        ? 'Đang xử lý...'
                        : 'Lưu Bản Sao CSDL (Cloud & Tải JSON)'}
                    </span>
                  </button>

                  <button
                    type="button"
                    disabled={isBackupWorking}
                    onClick={handleUpdateSavedDatabaseOnBlob}
                    className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    <span>Cập Nhật Bản Lưu Hiện Tại Lên Blob Store</span>
                  </button>

                  <label className="px-3.5 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition-colors cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    <span>Nạp Tệp Bản Sao (.json)</span>
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={handleImportBackupCopyFile}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              {/* Invoices Table */}
              <div className="bg-white border border-slate-200 rounded-xl p-5">
                <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-200">
                  <div>
                    <h2 className="text-base font-bold text-slate-900">
                      Lịch Sử Hóa Đơn Trong taphoadungcanh-blob ({invoices.length} phiếu)
                    </h2>
                    <p className="text-xs text-slate-500">
                      Bấm vào bất kỳ hóa đơn nào để xem lại, lưu bản sao mới, hoặc mở lên sửa rồi cập nhật bản lưu.
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-[11px] text-slate-500">
                      Tổng doanh thu đã lưu
                    </div>
                    <div className="text-base font-bold font-mono tabular-nums text-emerald-700">
                      {formatVND(
                        invoices.reduce((s, inv) => s + inv.totalAmount, 0)
                      )}{' '}
                      đ
                    </div>
                  </div>
                </div>

                {invoices.length === 0 ? (
                  <div className="py-10 text-center text-xs text-slate-500">
                    Chưa có hóa đơn nào được lưu. Khi thanh toán & in hoặc bấm "Lưu Bản Sao" ở mục Lên Bill, hóa đơn sẽ tự động lưu vào taphoadungcanh-blob.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {invoices.map((inv) => {
                      const isSelected = selectedHistoryInvoice?.id === inv.id;
                      return (
                        <div
                          key={inv.id}
                          onClick={() => setSelectedHistoryInvoice(inv)}
                          className={`py-3 px-3 rounded-lg flex items-center justify-between cursor-pointer transition-colors ${
                            isSelected ? 'bg-emerald-50' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div>
                            <div className="text-xs font-bold text-slate-900 flex items-center gap-2">
                              <FileText className="w-3.5 h-3.5 text-emerald-600" />
                              <span className="font-mono">
                                {inv.invoiceCode}
                              </span>
                              <span aria-hidden="true">·</span>
                              <span>{inv.customerName}</span>
                            </div>
                            <div className="text-[11px] text-slate-500 mt-0.5 tabular-nums">
                              {inv.createdAtDate
                                ? new Intl.DateTimeFormat('vi-VN', {
                                    day: '2-digit',
                                    month: '2-digit',
                                    year: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  }).format(inv.createdAtDate)
                                : ''}{' '}
                              · {inv.itemCount} sản phẩm · Khổ {inv.paperWidth}
                            </div>
                          </div>
                          <div className="text-right">
                            <div className="text-xs font-bold font-mono tabular-nums text-slate-900">
                              {formatVND(inv.totalAmount)} đ
                            </div>
                            <div className="flex flex-wrap items-center justify-end gap-2.5 mt-1">
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleLoadInvoiceToPosForUpdate(inv);
                                }}
                                className="text-[11px] text-slate-700 hover:text-slate-950 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                                title="Mở hóa đơn này sang mục Lên Bill để sửa và cập nhật bản lưu"
                              >
                                <RefreshCw className="w-3 h-3" />
                                <span>Sửa & Cập nhật bản lưu</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleSaveCopyOfBillToHistory(inv);
                                }}
                                className="text-[11px] text-emerald-700 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                                title="Tạo một bản sao mới từ hóa đơn này"
                              >
                                <Copy className="w-3 h-3" />
                                <span>Lưu bản sao</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setSelectedHistoryInvoice(inv);
                                  setTimeout(() => window.print(), 100);
                                }}
                                className="text-[11px] text-emerald-700 hover:underline font-medium inline-flex items-center gap-1 cursor-pointer"
                              >
                                <Printer className="w-3 h-3" />
                                <span>In lại bill</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setConfirmDialog({
                                    title: 'Xác nhận xóa hóa đơn đã lưu',
                                    message: `Bạn có chắc chắn muốn xóa hóa đơn "${inv.invoiceCode}" (${formatVND(inv.totalAmount)} đ) khỏi lịch sử taphoadungcanh-blob không?`,
                                    confirmLabel: 'Chắc chắn xóa hóa đơn',
                                    onConfirm: async () => {
                                      const nextInvoices = invoices.filter(
                                        (item) => item.id !== inv.id
                                      );
                                      setInvoices(nextInvoices);
                                      if (
                                        selectedHistoryInvoice?.id === inv.id
                                      ) {
                                        setSelectedHistoryInvoice(null);
                                      }
                                      void syncToSharedCloud({
                                        invoices: nextInvoices,
                                        replaceInvoices: true,
                                      });
                                      if (sessionToken) {
                                        try {
                                          await fetch(
                                            `/api/db/invoices/${encodeURIComponent(inv.id)}`,
                                            {
                                              method: 'DELETE',
                                              headers: {
                                                Authorization: `Bearer ${sessionToken}`,
                                              },
                                            }
                                          );
                                          setBlobSyncNotice(
                                            `Đã xóa hóa đơn ${inv.invoiceCode} khỏi taphoadungcanh-blob.`
                                          );
                                        } catch {
                                          // Ignore
                                        }
                                      }
                                    },
                                  });
                                }}
                                className="text-[11px] text-slate-400 hover:text-red-600 inline-flex items-center gap-0.5 cursor-pointer"
                                title="Xóa hóa đơn này"
                              >
                                <Trash2 className="w-3 h-3" />
                                <span>Xóa</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            {/* Right 5 cols: Selected Historical Receipt Preview (or Live Sample Receipt Preview with Bank QR) */}
            <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4">
              {selectedHistoryInvoice ? (
                <div>
                  <div className="no-print flex items-center justify-between pb-3 mb-3 border-b border-slate-200">
                    <span className="text-xs font-bold text-slate-900">
                      Xem lại phiếu {selectedHistoryInvoice.invoiceCode}
                    </span>
                    <button
                      type="button"
                      onClick={() => window.print()}
                      className="px-3 py-1.5 bg-slate-900 text-white text-xs font-semibold rounded-lg flex items-center gap-1.5 hover:bg-slate-800 cursor-pointer"
                    >
                      <Printer className="w-3.5 h-3.5" />
                      <span>In Lại Hóa Đơn Này</span>
                    </button>
                  </div>
                  <ThermalReceipt
                    invoiceCode={selectedHistoryInvoice.invoiceCode}
                    tabLabel={selectedHistoryInvoice.tabName}
                    customerName={selectedHistoryInvoice.customerName}
                    items={selectedHistoryInvoice.items}
                    discount={selectedHistoryInvoice.discount}
                    amountTendered={selectedHistoryInvoice.amountTendered}
                    storeProfile={storeProfile}
                    createdAtText={
                      selectedHistoryInvoice.createdAtDate
                        ? new Intl.DateTimeFormat('vi-VN', {
                            day: '2-digit',
                            month: '2-digit',
                            year: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          }).format(selectedHistoryInvoice.createdAtDate)
                        : undefined
                    }
                    readOnly={true}
                  />
                </div>
              ) : (
                <div>
                  <div className="no-print pb-3 mb-3 border-b border-slate-200 text-xs font-bold text-slate-900">
                    Xem trước mẫu Hóa Đơn Giấy Nhiệt & Mã QR Ngân Hàng
                  </div>
                  <ThermalReceipt
                    invoiceCode={currentInvoiceCode}
                    tabLabel={activeOrderTab.label}
                    customerName={activeOrderTab.customerName}
                    items={
                      activeOrderTab.items.length > 0
                        ? activeOrderTab.items
                        : [
                            {
                              lineId: 'preview_1',
                              barcode: '8934563138165',
                              name: 'Mì Hảo Hảo Tôm Chua Cay 75g',
                              unit: 'Gói',
                              price: 4500,
                              quantity: 2,
                            },
                            {
                              lineId: 'preview_2',
                              barcode: '8935049501015',
                              name: 'Nước Ngọt Coca-Cola Original Lon 320ml',
                              unit: 'Lon',
                              price: 10000,
                              quantity: 1,
                            },
                          ]
                    }
                    discount={0}
                    amountTendered={20000}
                    storeProfile={storeProfile}
                    readOnly={true}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </main>

      {/* Modal for automatic barcode product lookup when scanning an unknown barcode in POS */}
      {autoModalBarcode !== null && (
        <div className="no-print fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4 overflow-y-auto">
          <BarcodeAutoModal
            initialBarcode={autoModalBarcode}
            existingProducts={allProducts}
            onSaveProduct={handleSaveProductToBlobStore}
            onClose={() => setAutoModalBarcode(null)}
          />
        </div>
      )}

      {/* Global Confirmation Modal before deleting anything */}
      {confirmDialog !== null && (
        <div className="no-print fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white border border-slate-200 rounded-xl max-w-md w-full p-5 shadow-lg">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-red-50 text-red-600 rounded-lg shrink-0">
                <AlertTriangle className="w-5 h-5" />
              </div>
              <div className="flex-1">
                <h3 className="text-base font-bold text-slate-900">
                  {confirmDialog.title}
                </h3>
                <p className="text-xs text-slate-600 mt-1.5 leading-relaxed">
                  {confirmDialog.message}
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2.5 mt-5 pt-3.5 border-t border-slate-200">
              <button
                type="button"
                onClick={() => setConfirmDialog(null)}
                className="px-4 py-2 text-xs font-semibold text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer"
              >
                Hủy bỏ (Không xóa)
              </button>
              <button
                type="button"
                onClick={async () => {
                  const action = confirmDialog.onConfirm;
                  setConfirmDialog(null);
                  await action();
                }}
                className="px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{confirmDialog.confirmLabel || 'Chắc chắn xóa'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
