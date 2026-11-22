import React, { useState, useEffect, useRef } from 'react';
import { Barcode, Search, Save, ShoppingCart, Sparkles, RefreshCw, X } from 'lucide-react';
import {
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
  VIETNAM_BARCODE_CATALOG,
  GS1_BRAND_PREFIXES,
} from '../data/vietnamBarcodes.ts';
import { Product } from '../types.ts';

interface BarcodeAutoModalProps {
  initialBarcode?: string;
  existingProducts: Product[];
  onSaveProduct: (
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
  ) => Promise<void>;
  onClose?: () => void;
  isEmbedded?: boolean;
}

export const BarcodeAutoModal: React.FC<BarcodeAutoModalProps> = ({
  initialBarcode = '',
  existingProducts,
  onSaveProduct,
  onClose,
  isEmbedded = false,
}) => {
  const [barcode, setBarcode] = useState(initialBarcode);
  const [name, setName] = useState('');
  const [category, setCategory] = useState(PRODUCT_CATEGORIES[0]);
  const [unit, setUnit] = useState(PRODUCT_UNITS[0]);
  const [price, setPrice] = useState<number>(10000);
  const [costPrice, setCostPrice] = useState<number>(8000);
  const [stock, setStock] = useState<number>(50);
  const [billQuantity, setBillQuantity] = useState<number>(1);
  const [source, setSource] = useState<string>('barcode_auto');
  const [lookupStatus, setLookupStatus] = useState<string>('');
  const [isLookingUp, setIsLookingUp] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string>('');

  const priceInputRef = useRef<HTMLInputElement>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);

  const performAutoLookup = async (codeToLookup: string) => {
    const cleanCode = codeToLookup.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanCode) return;

    setBarcode(cleanCode);
    setIsLookingUp(true);
    setLookupStatus('Đang tự động tra cứu thông tin mã vạch...');

    // 1. Check if already in user's inventory (Firestore + 20,738+ Vietnam master catalog)
    const existing = existingProducts.find((p) => p.barcode === cleanCode);
    if (existing) {
      setName(existing.name);
      setCategory(existing.category);
      setUnit(existing.unit);
      setPrice(existing.price);
      setCostPrice(existing.costPrice);
      setStock(existing.stock);
      setSource(existing.source || 'barcode_auto');
      setLookupStatus('Đã tìm thấy trong Kho Hàng — Bạn có thể chỉnh giá & tồn kho rồi Lưu!');
      setIsLookingUp(false);
      setTimeout(() => priceInputRef.current?.focus(), 80);
      return;
    }

    // 2. Call server-side automatic barcode lookup (/api/barcode/lookup)
    let resolved = false;
    try {
      const res = await fetch('/api/barcode/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ barcode: cleanCode }),
      });

      const contentType = res.headers.get('content-type') || '';
      if (res.ok && contentType.includes('application/json')) {
        const data = await res.json();
        if (data?.product) {
          setName(data.product.name || `Hàng tạp hóa #${cleanCode.slice(-4)}`);
          setCategory(
            PRODUCT_CATEGORIES.includes(data.product.category)
              ? data.product.category
              : PRODUCT_CATEGORIES[0]
          );
          setUnit(
            PRODUCT_UNITS.includes(data.product.unit) ? data.product.unit : PRODUCT_UNITS[0]
          );
          setPrice(Number(data.product.price) || 10000);
          setCostPrice(Number(data.product.costPrice) || 8000);
          setSource(data.source || 'barcode_auto');
          setLookupStatus(
            `${data.sourceLabel || 'Đã điền thông tin tự động'} — Bạn chỉ cần chỉnh giá và số lượng rồi Lưu!`
          );
          resolved = true;
        }
      }
    } catch {
      // Fallback to direct client-side lookup (e.g. when deployed as static site on Vercel)
    }

    // 3. Direct browser fallback for static Vercel deployments (OpenFoodFacts + GS1 Vietnam prefix)
    if (!resolved) {
      try {
        const offRes = await fetch(
          `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(cleanCode)}.json`
        );
        if (offRes.ok) {
          const offData = await offRes.json();
          if (offData?.status === 1 && offData?.product) {
            const pName =
              offData.product.product_name_vi ||
              offData.product.product_name ||
              '';
            if (pName) {
              setName(pName.slice(0, 180));
              setPrice(15000);
              setCostPrice(12500);
              setSource('openfoodfacts');
              setLookupStatus(
                'Tra cứu dữ liệu mã vạch trực tuyến — Bạn chỉ cần chỉnh giá và số lượng rồi Lưu!'
              );
              resolved = true;
            }
          }
        }
      } catch {
        // Ignore network error
      }
    }

    if (!resolved) {
      const matchedPrefix = GS1_BRAND_PREFIXES.find((item) =>
        cleanCode.startsWith(item.prefix)
      );
      if (matchedPrefix) {
        setName(`${matchedPrefix.brand} #${cleanCode.slice(-4)}`);
        setCategory(matchedPrefix.category);
        setUnit(matchedPrefix.defaultUnit);
        setPrice(matchedPrefix.defaultPrice);
        setCostPrice(Math.round(matchedPrefix.defaultPrice * 0.85));
        setSource('gs1_prefix_vn');
        setLookupStatus(
          `Nhận diện thương hiệu GS1 (${matchedPrefix.brand}) — Bạn chỉ cần chỉnh giá và số lượng rồi Lưu!`
        );
      } else {
        const countryHint = cleanCode.startsWith('893')
          ? 'Hàng Việt Nam'
          : cleanCode.startsWith('885')
            ? 'Hàng Thái Lan'
            : 'Hàng tạp hóa';
        setName(`${countryHint} #${cleanCode.slice(-4)}`);
        setPrice(10000);
        setCostPrice(8000);
        setLookupStatus('Mã vạch mới — Đã tạo mẫu tự động, bạn chỉ cần chỉnh tên/giá và lưu.');
      }
    }

    setIsLookingUp(false);
    setTimeout(() => {
      priceInputRef.current?.focus();
      priceInputRef.current?.select();
    }, 80);
  };

  useEffect(() => {
    if (initialBarcode) {
      performAutoLookup(initialBarcode);
    }
  }, [initialBarcode]);

  const handleSubmit = async (addToBill: boolean) => {
    const cleanBarcode = barcode.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanBarcode || !name.trim()) {
      setStatusMessage('Vui lòng nhập mã vạch và tên hàng hóa.');
      return;
    }

    setIsSaving(true);
    setStatusMessage('');
    try {
      await onSaveProduct(
        {
          barcode: cleanBarcode.slice(0, 64),
          name: name.trim().slice(0, 200),
          category: category.slice(0, 100),
          unit: unit.slice(0, 50),
          price: Math.max(0, Math.round(Number(price) || 0)),
          costPrice: Math.max(0, Math.round(Number(costPrice) || 0)),
          stock: Math.max(0, Math.round(Number(stock) || 0)),
          source: source.slice(0, 50),
        },
        addToBill,
        Math.max(1, Math.round(Number(billQuantity) || 1))
      );

      setStatusMessage(
        addToBill
          ? `Đã lưu "${name.trim()}" vào kho và thêm vào phiếu bán hàng!`
          : `Đã lưu "${name.trim()}" vào cơ sở dữ liệu kho hàng!`
      );

      if (!onClose) {
        // Reset for next scan in embedded mode
        setBarcode('');
        setName('');
        setLookupStatus('Sẵn sàng quét mã vạch tiếp theo...');
        setTimeout(() => barcodeInputRef.current?.focus(), 80);
      }
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : 'Không thể lưu sản phẩm. Vui lòng thử lại.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const sampleCatalogList = Object.values(VIETNAM_BARCODE_CATALOG).slice(0, 8);

  return (
    <div
      className={`bg-white ${
        isEmbedded ? 'border border-slate-200 rounded-xl p-6' : 'rounded-xl p-6 max-w-2xl w-full'
      }`}
    >
      <div className="flex items-center justify-between pb-4 mb-5 border-b border-slate-200">
        <div>
          <h2 className="text-lg font-bold text-slate-900">
            Quét Barcode Tự Động Điền Thông Tin Hàng Hóa
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Quét mã vạch bằng súng bắn mã vạch hoặc nhập mã EAN-13 — Hệ thống tự tìm tên hàng, bạn chỉ cần chỉnh giá & số lượng tồn kho rồi Lưu.
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* Step 1: Scan or type barcode */}
      <div className="mb-5">
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">
          1. Mã vạch sản phẩm (Quét từ máy quét hoặc nhập mã rồi nhấn Enter)
        </label>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Barcode className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              ref={barcodeInputRef}
              type="text"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  performAutoLookup(barcode);
                }
              }}
              placeholder="Ví dụ: 8934563138165 (Quét mã vạch tự động nhấn Enter...)"
              className="w-full pl-10 pr-4 py-2.5 text-sm font-mono bg-slate-50 border border-slate-300 rounded-lg focus:bg-white focus:border-emerald-600 focus:outline-none"
            />
          </div>
          <button
            type="button"
            disabled={isLookingUp || !barcode.trim()}
            onClick={() => performAutoLookup(barcode)}
            className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isLookingUp ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            <span>Tra cứu tự động</span>
          </button>
        </div>

        {/* Quick-test sample barcodes for instant testing without physical scanner */}
        <div className="mt-2.5">
          <div className="text-[11px] text-slate-500 mb-1.5">
            Hoặc bấm thử máy quét với các mã vạch tạp hóa mẫu phổ biến:
          </div>
          <div className="flex flex-wrap gap-1.5">
            {sampleCatalogList.map((item) => (
              <button
                key={item.barcode}
                type="button"
                onClick={() => performAutoLookup(item.barcode)}
                className="px-2.5 py-1 text-xs bg-slate-100 hover:bg-emerald-50 hover:text-emerald-800 text-slate-700 rounded-md transition-colors font-mono cursor-pointer"
              >
                {item.barcode} · {item.name.split(' ').slice(0, 3).join(' ')}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Status notice from automatic lookup */}
      {lookupStatus && (
        <div className="mb-5 px-3.5 py-2.5 bg-emerald-50/90 border border-emerald-200 rounded-lg flex items-center gap-2 text-xs text-emerald-900">
          <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{lookupStatus}</span>
        </div>
      )}

      {/* Step 2: Auto-filled product fields + Highlighted Price & Quantity fields */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-4 mb-5">
        <div className="md:col-span-8">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Tên hàng hóa (Tự động điền — Có thể sửa lại)
          </label>
          <input
            type="text"
            value={name}
            maxLength={200}
            onChange={(e) => setName(e.target.value)}
            placeholder="Tên sản phẩm tự động hiện ở đây sau khi quét..."
            className="w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:border-slate-900 focus:outline-none font-medium"
          />
        </div>

        <div className="md:col-span-4">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Đơn vị tính
          </label>
          <select
            value={unit}
            onChange={(e) => setUnit(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:border-slate-900 focus:outline-none"
          >
            {PRODUCT_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-5">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Nhóm hàng tạp hóa
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:border-slate-900 focus:outline-none"
          >
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {/* Highlighted Price & Stock Inputs */}
        <div className="md:col-span-4">
          <label className="block text-xs font-bold text-emerald-800 mb-1">
            2. Giá bán lẻ (VNĐ) — Chỉnh tại đây
          </label>
          <input
            ref={priceInputRef}
            type="number"
            min={0}
            step={500}
            value={price}
            onChange={(e) => setPrice(Math.max(0, Number(e.target.value) || 0))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit(Boolean(onClose));
              }
            }}
            className="w-full px-3.5 py-2 text-base font-bold font-mono tabular-nums bg-emerald-50/70 border-2 border-emerald-500 rounded-lg text-slate-900 focus:bg-white focus:outline-none"
          />
        </div>

        <div className="md:col-span-3">
          <label className="block text-xs font-bold text-emerald-800 mb-1">
            3. Số lượng kho
          </label>
          <input
            type="number"
            min={0}
            step={1}
            value={stock}
            onChange={(e) => setStock(Math.max(0, Number(e.target.value) || 0))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSubmit(Boolean(onClose));
              }
            }}
            className="w-full px-3.5 py-2 text-base font-bold font-mono tabular-nums bg-emerald-50/70 border-2 border-emerald-500 rounded-lg text-slate-900 focus:bg-white focus:outline-none"
          />
        </div>

        <div className="md:col-span-6">
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Giá vốn nhập vào (VNĐ - Tùy chọn)
          </label>
          <input
            type="number"
            min={0}
            step={500}
            value={costPrice}
            onChange={(e) => setCostPrice(Math.max(0, Number(e.target.value) || 0))}
            className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none"
          />
        </div>

        <div className="md:col-span-6">
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Số lượng đưa vào Bill hiện tại (Nếu lưu & bán ngay)
          </label>
          <input
            type="number"
            min={1}
            step={1}
            value={billQuantity}
            onChange={(e) => setBillQuantity(Math.max(1, Number(e.target.value) || 1))}
            className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-lg focus:bg-white focus:border-slate-900 focus:outline-none"
          />
        </div>
      </div>

      {statusMessage && (
        <div className="mb-4 px-3.5 py-2 bg-slate-100 rounded-lg text-xs font-medium text-slate-800">
          {statusMessage}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex flex-wrap items-center justify-end gap-3 pt-4 border-t border-slate-200">
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-lg"
          >
            Đóng
          </button>
        )}
        <button
          type="button"
          disabled={isSaving || !barcode.trim() || !name.trim()}
          onClick={() => handleSubmit(false)}
          className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Save className="w-4 h-4" />
          <span>Lưu Vào Kho Hàng (CSDL)</span>
        </button>
        <button
          type="button"
          disabled={isSaving || !barcode.trim() || !name.trim()}
          onClick={() => handleSubmit(true)}
          className="px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xs font-semibold rounded-lg flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <ShoppingCart className="w-4 h-4" />
          <span>Lưu Vào Kho & Thêm Ngay Vào Bill</span>
        </button>
      </div>
    </div>
  );
};
