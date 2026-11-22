export interface Product {
  id: string;
  barcode: string;
  name: string;
  category: string;
  unit: string;
  price: number;
  costPrice: number;
  stock: number;
  source: string;
  ownerId: string;
  isCustomOrEdited?: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface BillLineItem {
  lineId: string;
  productId?: string;
  barcode: string;
  /**
   * Editable right on the bill/receipt before printing!
   */
  name: string;
  unit: string;
  price: number;
  quantity: number;
  note?: string;
}

export interface PosOrderTab {
  id: string;
  tabNumber: number;
  label: string;
  customerName: string;
  createdAtIso: string;
  items: BillLineItem[];
  discount: number;
  amountTendered: number;
}

export interface InvoiceRecord {
  id: string;
  invoiceCode: string;
  tabName: string;
  customerName: string;
  itemsJson: string;
  items: BillLineItem[];
  itemCount: number;
  subtotal: number;
  discount: number;
  totalAmount: number;
  amountTendered: number;
  changeDue: number;
  paperWidth: '58mm' | '80mm';
  ownerId: string;
  createdAt?: unknown;
  createdAtDate?: Date;
}

export interface StoreProfile {
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
