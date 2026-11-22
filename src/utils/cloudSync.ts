import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  onSnapshot,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import {
  Product,
  InvoiceRecord,
  StoreProfile,
  PosOrderTab,
  BillLineItem,
} from '../types';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const firestoreDb = getFirestore(app, firebaseConfig.firestoreDatabaseId);

const SHARED_COLLECTION = 'taphoadungcanh_blob';
const SHARED_DOC_ID = 'database';

export interface CloudSyncSnapshot {
  storeId: string;
  updatedAtIso: string;
  storeProfile: StoreProfile;
  products: Product[];
  deletedBarcodes: Record<string, boolean>;
  invoices: InvoiceRecord[];
  orderTabs: PosOrderTab[];
  activeTabId: string;
  currentInvoiceCode: string;
}

interface RawFirestoreSharedDoc {
  storeId?: string;
  updatedAtIso?: string;
  storeProfileJson?: string;
  productsJson?: string;
  deletedBarcodesJson?: string;
  invoicesJson?: string;
  orderTabsJson?: string;
  activeTabId?: string;
  currentInvoiceCode?: string;
}

function parseRawFirestoreDoc(
  raw: RawFirestoreSharedDoc | undefined
): CloudSyncSnapshot | null {
  if (!raw || !raw.updatedAtIso) return null;

  try {
    const storeProfile = raw.storeProfileJson
      ? (JSON.parse(raw.storeProfileJson) as StoreProfile)
      : null;
    if (!storeProfile) return null;

    const rawProducts = raw.productsJson ? JSON.parse(raw.productsJson) : {};
    const productsList: Product[] = [];

    if (Array.isArray(rawProducts)) {
      for (const p of rawProducts) {
        if (!p || !p.barcode) continue;
        productsList.push({
          id: String(p.id || `blob_prod_${p.barcode}`),
          barcode: String(p.barcode),
          name: String(p.name || ''),
          category: String(p.category || 'Hàng tạp hóa khác'),
          unit: String(p.unit || 'Cái'),
          price: Number(p.price) || 0,
          costPrice: Number(p.costPrice) || 0,
          stock: Number(p.stock) || 0,
          source: String(p.source || 'taphoadungcanh-blob'),
          ownerId: 'taphoadungcanh-blob',
          isCustomOrEdited: true,
        });
      }
    } else if (rawProducts && typeof rawProducts === 'object') {
      for (const [key, val] of Object.entries(rawProducts)) {
        const p = val as Record<string, unknown>;
        const code = String(p?.barcode || key).trim();
        if (!code) continue;
        productsList.push({
          id: String(p?.id || `blob_prod_${code}`),
          barcode: code,
          name: String(p?.name || ''),
          category: String(p?.category || 'Hàng tạp hóa khác'),
          unit: String(p?.unit || 'Cái'),
          price: Number(p?.price) || 0,
          costPrice: Number(p?.costPrice) || 0,
          stock: Number(p?.stock) || 0,
          source: String(p?.source || 'taphoadungcanh-blob'),
          ownerId: 'taphoadungcanh-blob',
          isCustomOrEdited: true,
        });
      }
    }

    const deletedBarcodes: Record<string, boolean> = raw.deletedBarcodesJson
      ? JSON.parse(raw.deletedBarcodesJson)
      : {};

    const rawInvoices = raw.invoicesJson ? JSON.parse(raw.invoicesJson) : [];
    const invoices: InvoiceRecord[] = Array.isArray(rawInvoices)
      ? rawInvoices.map((inv: Record<string, unknown>) => {
          let parsedItems: BillLineItem[] = [];
          try {
            parsedItems = JSON.parse(String(inv.itemsJson || '[]'));
          } catch {
            parsedItems = [];
          }
          const createdIso = String(
            inv.createdAtIso ||
              inv.createdAtDate ||
              new Date().toISOString()
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
            createdAtDate: new Date(createdIso),
          };
        })
      : [];

    const rawTabs = raw.orderTabsJson ? JSON.parse(raw.orderTabsJson) : [];
    const orderTabs: PosOrderTab[] = Array.isArray(rawTabs) ? rawTabs : [];

    return {
      storeId: String(raw.storeId || 'store_fEebWPRqDwMcS4oB'),
      updatedAtIso: String(raw.updatedAtIso),
      storeProfile,
      products: productsList,
      deletedBarcodes,
      invoices,
      orderTabs,
      activeTabId: String(raw.activeTabId || ''),
      currentInvoiceCode: String(raw.currentInvoiceCode || ''),
    };
  } catch {
    return null;
  }
}

export async function pullStateFromCloudFirestore(): Promise<CloudSyncSnapshot | null> {
  try {
    const ref = doc(firestoreDb, SHARED_COLLECTION, SHARED_DOC_ID);
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    return parseRawFirestoreDoc(snap.data() as RawFirestoreSharedDoc);
  } catch {
    return null;
  }
}

export function subscribeToCloudFirestore(
  onUpdate: (snapshot: CloudSyncSnapshot) => void
): () => void {
  const ref = doc(firestoreDb, SHARED_COLLECTION, SHARED_DOC_ID);
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) return;
      const parsed = parseRawFirestoreDoc(snap.data() as RawFirestoreSharedDoc);
      if (parsed) {
        onUpdate(parsed);
      }
    },
    () => {
      // Ignore transient listener errors
    }
  );
}

export async function pushStateToCloudFirestore(payload: {
  storeId?: string;
  updatedAtIso?: string;
  storeProfile: StoreProfile;
  products: Product[];
  deletedBarcodes: Record<string, boolean>;
  invoices: InvoiceRecord[];
  orderTabs: PosOrderTab[];
  activeTabId: string;
  currentInvoiceCode: string;
  replaceInvoices?: boolean;
}): Promise<string | null> {
  try {
    const ref = doc(firestoreDb, SHARED_COLLECTION, SHARED_DOC_ID);

    // Read existing cloud document first so we NEVER accidentally wipe products or invoices from another device
    const existingSnap = await getDoc(ref).catch(() => null);
    const existingParsed =
      existingSnap && existingSnap.exists()
        ? parseRawFirestoreDoc(existingSnap.data() as RawFirestoreSharedDoc)
        : null;

    const mergedDeleted: Record<string, boolean> = {
      ...(existingParsed?.deletedBarcodes || {}),
      ...(payload.deletedBarcodes || {}),
    };

    const productsMap: Record<string, Record<string, unknown>> = {};
    if (existingParsed?.products) {
      for (const p of existingParsed.products) {
        if (p.barcode && !mergedDeleted[p.barcode]) {
          productsMap[p.barcode] = {
            id: p.id || `blob_prod_${p.barcode}`,
            barcode: p.barcode,
            name: p.name,
            category: p.category,
            unit: p.unit,
            price: p.price,
            costPrice: p.costPrice,
            stock: p.stock,
            source: p.source || 'taphoadungcanh-blob',
          };
        }
      }
    }

    for (const p of payload.products) {
      if (p.barcode) {
        delete mergedDeleted[p.barcode];
        productsMap[p.barcode] = {
          id: p.id || `blob_prod_${p.barcode}`,
          barcode: p.barcode,
          name: p.name,
          category: p.category,
          unit: p.unit,
          price: p.price,
          costPrice: p.costPrice,
          stock: p.stock,
          source: p.source || 'taphoadungcanh-blob',
        };
      }
    }

    for (const delCode of Object.keys(mergedDeleted)) {
      if (mergedDeleted[delCode]) {
        delete productsMap[delCode];
      }
    }

    const nowIso = payload.updatedAtIso || new Date().toISOString();
    const safeStoreProfile = {
      ...payload.storeProfile,
      customQrDataUrl: (payload.storeProfile.customQrDataUrl || '').slice(
        0,
        220000
      ),
    };

    const invoiceCandidates = payload.replaceInvoices
      ? payload.invoices
      : [...payload.invoices, ...(existingParsed?.invoices || [])];
    const seenInvoiceIds = new Set<string>();
    const mergedInvoices: InvoiceRecord[] = [];
    for (const inv of invoiceCandidates) {
      if (!inv || !inv.id || seenInvoiceIds.has(inv.id)) continue;
      seenInvoiceIds.add(inv.id);
      mergedInvoices.push(inv);
    }

    const compactInvoices = mergedInvoices.slice(0, 400).map((inv) => ({
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
      createdAtIso:
        inv.createdAtDate instanceof Date
          ? inv.createdAtDate.toISOString()
          : String(inv.createdAtDate || nowIso),
    }));

    const docBody = {
      storeId: String(payload.storeId || 'store_fEebWPRqDwMcS4oB').slice(0, 64),
      updatedAtIso: nowIso.slice(0, 64),
      storeProfileJson: JSON.stringify(safeStoreProfile).slice(0, 300000),
      productsJson: JSON.stringify(productsMap).slice(0, 350000),
      deletedBarcodesJson: JSON.stringify(mergedDeleted).slice(0, 100000),
      invoicesJson: JSON.stringify(compactInvoices).slice(0, 300000),
      orderTabsJson: JSON.stringify(payload.orderTabs.slice(0, 20)).slice(
        0,
        150000
      ),
      activeTabId: String(payload.activeTabId || 'tab_1').slice(0, 100) || 'tab_1',
      currentInvoiceCode:
        String(payload.currentInvoiceCode || 'DC-0001').slice(0, 64) ||
        'DC-0001',
    };

    await setDoc(ref, docBody);
    return nowIso;
  } catch {
    return null;
  }
}
