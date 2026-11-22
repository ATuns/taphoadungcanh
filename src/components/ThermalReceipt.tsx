import React, { useState, useEffect } from 'react';
import { Printer, Edit3, Check, Plus, Minus, Trash2, QrCode } from 'lucide-react';
import { BillLineItem, StoreProfile } from '../types.ts';
import { generateVietQrDataUrl } from '../utils/vietqr.ts';

interface ThermalReceiptProps {
  invoiceCode: string;
  tabLabel: string;
  customerName: string;
  items: BillLineItem[];
  discount: number;
  amountTendered: number;
  storeProfile: StoreProfile;
  createdAtText?: string;
  readOnly?: boolean;
  onUpdateItemName?: (lineId: string, newName: string) => void;
  onUpdateItemPrice?: (lineId: string, newPrice: number) => void;
  onUpdateItemQuantity?: (lineId: string, newQty: number) => void;
  onRemoveItem?: (lineId: string) => void;
  onChangePaperWidth?: (width: '58mm' | '80mm') => void;
  onPrintAndSave?: () => void;
  onOpenQrSettings?: () => void;
  isSaving?: boolean;
}

export function formatVND(amount: number): string {
  return new Intl.NumberFormat('vi-VN').format(Math.round(amount || 0));
}

export const ThermalReceipt: React.FC<ThermalReceiptProps> = ({
  invoiceCode,
  tabLabel,
  customerName,
  items,
  discount,
  amountTendered,
  storeProfile,
  createdAtText,
  readOnly = false,
  onUpdateItemName,
  onUpdateItemPrice,
  onUpdateItemQuantity,
  onRemoveItem,
  onChangePaperWidth,
  onPrintAndSave,
  onOpenQrSettings,
  isSaving = false,
}) => {
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [generatedQrUrl, setGeneratedQrUrl] = useState<string>('');

  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
  const finalTotal = Math.max(0, subtotal - (discount || 0));
  const actualTendered = amountTendered > 0 ? amountTendered : finalTotal;
  const changeDue = Math.max(0, actualTendered - finalTotal);

  useEffect(() => {
    let isMounted = true;
    if (storeProfile.customQrDataUrl) {
      setGeneratedQrUrl(storeProfile.customQrDataUrl);
      return;
    }

    const notePrefix = (storeProfile.bankQrNoteTemplate || 'TT').trim();
    const transferNote = `${notePrefix} ${invoiceCode}`.trim();

    generateVietQrDataUrl({
      bankBin: storeProfile.bankBin || '970436',
      accountNumber: storeProfile.bankAccountNumber || '0123456789',
      amount: finalTotal,
      addInfo: transferNote,
    }).then((url) => {
      if (isMounted) setGeneratedQrUrl(url);
    });

    return () => {
      isMounted = false;
    };
  }, [
    storeProfile.customQrDataUrl,
    storeProfile.bankBin,
    storeProfile.bankAccountNumber,
    storeProfile.bankQrNoteTemplate,
    finalTotal,
    invoiceCode,
  ]);

  const timestampDisplay =
    createdAtText ||
    new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date());

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar above receipt preview */}
      <div className="no-print flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-slate-200">
        <div className="flex items-center gap-2 text-xs text-slate-600">
          <span className="font-semibold text-slate-900">Bản in giấy nhiệt</span>
          <span aria-hidden="true">·</span>
          <span>Bấm vào tên hàng trên bill để sửa</span>
        </div>
        <div className="flex items-center gap-2">
          {onOpenQrSettings && (
            <button
              type="button"
              onClick={onOpenQrSettings}
              className="px-2.5 py-1 text-xs font-medium text-emerald-800 bg-emerald-50 hover:bg-emerald-100 rounded-md flex items-center gap-1 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Điều chỉnh mã QR ngân hàng trong mục Lịch sử bill"
            >
              <QrCode className="w-3.5 h-3.5" />
              <span>Chỉnh QR Ngân Hàng</span>
            </button>
          )}
          {onChangePaperWidth && (
            <div className="flex items-center gap-1 p-0.5 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => onChangePaperWidth('58mm')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  storeProfile.paperWidth === '58mm'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                K58 (58mm)
              </button>
              <button
                type="button"
                onClick={() => onChangePaperWidth('80mm')}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  storeProfile.paperWidth === '80mm'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                K80 (80mm)
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Thermal Paper Roll Container */}
      <div className="flex-1 overflow-y-auto flex justify-center bg-slate-100/80 p-4 rounded-xl border border-slate-200">
        <div
          id="thermal-receipt-printable"
          className={`bg-white text-black font-mono text-xs leading-relaxed border border-slate-300 shadow-xs transition-all h-fit ${
            storeProfile.paperWidth === '58mm' ? 'w-[280px] p-4' : 'w-[360px] p-5'
          }`}
        >
          {/* Top Store Header */}
          <div className="text-center pb-3 border-b border-dashed border-slate-400">
            <div className="text-base font-bold tracking-tight uppercase">
              {storeProfile.storeName}
            </div>
            <div className="text-[11px] text-slate-700 mt-0.5">{storeProfile.address}</div>
            <div className="text-[11px] text-slate-700">SĐT: {storeProfile.phone}</div>
          </div>

          {/* Receipt Metadata */}
          <div className="py-2.5 border-b border-dashed border-slate-400 space-y-0.5 text-[11px]">
            <div className="text-center font-bold text-xs uppercase pb-1">
              HÓA ĐƠN BÁN LẺ
            </div>
            <div className="flex justify-between">
              <span>Số phiếu:</span>
              <span className="font-semibold tabular-nums">{invoiceCode}</span>
            </div>
            <div className="flex justify-between">
              <span>Quầy / Đơn:</span>
              <span>{tabLabel}</span>
            </div>
            <div className="flex justify-between">
              <span>Khách hàng:</span>
              <span className="truncate max-w-[170px]">{customerName || 'Khách lẻ'}</span>
            </div>
            <div className="flex justify-between">
              <span>Thời gian:</span>
              <span className="tabular-nums">{timestampDisplay}</span>
            </div>
          </div>

          {/* Column Headers */}
          <div className="py-1.5 border-b border-dashed border-slate-400 flex justify-between text-[11px] font-bold">
            <span>TÊN HÀNG HÓA (SL x Đ.GIÁ)</span>
            <span>THÀNH TIỀN</span>
          </div>

          {/* Line Items on Long Thermal Paper */}
          {items.length === 0 ? (
            <div className="py-8 text-center text-slate-400 text-[11px]">
              Chưa có mặt hàng nào trong phiếu.
              <br />
              Quét mã vạch hoặc chọn hàng bên trái.
            </div>
          ) : (
            <div className="divide-y divide-dashed divide-slate-300">
              {items.map((item, idx) => {
                const isEditing = !readOnly && editingLineId === item.lineId;
                const lineTotal = item.price * item.quantity;

                return (
                  <div key={item.lineId} className="py-2 group">
                    {/* Line 1: Index + Editable Product Name directly on the receipt */}
                    <div className="flex items-start justify-between gap-1">
                      {isEditing ? (
                        <div className="no-print flex items-center gap-1 w-full mb-1">
                          <input
                            type="text"
                            value={item.name}
                            maxLength={180}
                            autoFocus
                            onChange={(e) =>
                              onUpdateItemName && onUpdateItemName(item.lineId, e.target.value)
                            }
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') setEditingLineId(null);
                            }}
                            className="flex-1 px-1.5 py-0.5 text-xs font-mono bg-amber-50 border border-amber-400 rounded text-slate-900 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => setEditingLineId(null)}
                            className="p-1 bg-emerald-600 text-white rounded hover:bg-emerald-700"
                            title="Xong"
                          >
                            <Check className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-start justify-between w-full gap-1">
                          <button
                            type="button"
                            disabled={readOnly}
                            onClick={() => !readOnly && setEditingLineId(item.lineId)}
                            className={`text-left font-semibold text-black leading-snug break-words flex-1 ${
                              !readOnly
                                ? 'hover:bg-amber-50/80 hover:underline decoration-dashed cursor-pointer rounded px-0.5 -mx-0.5'
                                : ''
                            }`}
                            title={
                              readOnly
                                ? item.name
                                : 'Bấm để sửa trực tiếp tên hàng hóa trên hóa đơn trước khi in'
                            }
                          >
                            {idx + 1}. {item.name}
                          </button>
                          {!readOnly && (
                            <div className="no-print flex items-center gap-0.5 opacity-75 group-hover:opacity-100 shrink-0">
                              <button
                                type="button"
                                onClick={() => setEditingLineId(item.lineId)}
                                className="p-0.5 text-slate-500 hover:text-slate-900"
                                title="Sửa tên hàng trên bill"
                              >
                                <Edit3 className="w-3 h-3" />
                              </button>
                              {onRemoveItem && (
                                <button
                                  type="button"
                                  onClick={() => onRemoveItem(item.lineId)}
                                  className="p-0.5 text-slate-400 hover:text-red-600"
                                  title="Xóa dòng này"
                                >
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Line 2: Quantity x Unit Price = Subtotal */}
                    <div className="flex items-center justify-between text-[11px] mt-0.5 text-slate-800">
                      <div className="flex items-center gap-1.5">
                        {!readOnly && onUpdateItemQuantity ? (
                          <div className="no-print inline-flex items-center gap-1 bg-slate-100 rounded px-1 py-0.5">
                            <button
                              type="button"
                              onClick={() =>
                                onUpdateItemQuantity(item.lineId, Math.max(1, item.quantity - 1))
                              }
                              className="text-slate-600 hover:text-black"
                            >
                              <Minus className="w-2.5 h-2.5" />
                            </button>
                            <span className="font-bold tabular-nums px-1">{item.quantity}</span>
                            <button
                              type="button"
                              onClick={() => onUpdateItemQuantity(item.lineId, item.quantity + 1)}
                              className="text-slate-600 hover:text-black"
                            >
                              <Plus className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        ) : null}
                        <span className={readOnly ? 'tabular-nums' : 'hidden print:inline tabular-nums'}>
                          {item.quantity}
                        </span>
                        <span>{item.unit}</span>
                        <span>x</span>
                        {!readOnly && onUpdateItemPrice ? (
                          <input
                            type="number"
                            value={item.price}
                            min={0}
                            step={500}
                            onChange={(e) =>
                              onUpdateItemPrice(item.lineId, Math.max(0, Number(e.target.value) || 0))
                            }
                            className="no-print w-20 px-1 py-0.5 text-[11px] font-mono tabular-nums bg-slate-50 border border-slate-200 rounded text-right focus:border-slate-900 focus:outline-none"
                            title="Sửa đơn giá trực tiếp"
                          />
                        ) : null}
                        <span className={readOnly ? 'tabular-nums' : 'hidden print:inline tabular-nums'}>
                          {formatVND(item.price)}
                        </span>
                      </div>
                      <span className="font-bold tabular-nums text-black">
                        {formatVND(lineTotal)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Totals Section */}
          <div className="pt-2.5 mt-1 border-t border-dashed border-slate-400 space-y-1 text-[11px]">
            <div className="flex justify-between">
              <span>Tổng số lượng:</span>
              <span className="tabular-nums font-medium">{totalQuantity} món</span>
            </div>
            <div className="flex justify-between">
              <span>Tạm tính:</span>
              <span className="tabular-nums">{formatVND(subtotal)} đ</span>
            </div>
            {discount > 0 && (
              <div className="flex justify-between">
                <span>Chiết khấu / Giảm:</span>
                <span className="tabular-nums">-{formatVND(discount)} đ</span>
              </div>
            )}
            <div className="flex justify-between text-sm font-bold pt-1 border-t border-slate-300">
              <span>TỔNG THANH TOÁN:</span>
              <span className="tabular-nums">{formatVND(finalTotal)} đ</span>
            </div>
            <div className="flex justify-between pt-0.5">
              <span>Tiền khách đưa:</span>
              <span className="tabular-nums">{formatVND(actualTendered)} đ</span>
            </div>
            <div className="flex justify-between font-semibold">
              <span>Tiền thừa trả khách:</span>
              <span className="tabular-nums">{formatVND(changeDue)} đ</span>
            </div>
          </div>

          {/* Bank Transfer QR Code Section (Replaced old bottom barcode/customer code) */}
          <div className="mt-4 pt-3 border-t border-dashed border-slate-400 text-center">
            <div className="text-[11px] font-bold uppercase tracking-tight">
              QUÉT MÃ QR CHUYỂN KHOẢN NGÂN HÀNG
            </div>

            {generatedQrUrl ? (
              <div className="my-2 flex justify-center">
                <img
                  src={generatedQrUrl}
                  alt="Mã QR chuyển khoản ngân hàng"
                  referrerPolicy="no-referrer"
                  className="w-36 h-36 object-contain border border-slate-200 p-1 bg-white"
                />
              </div>
            ) : (
              <div className="my-2 mx-auto w-32 h-32 border border-dashed border-slate-400 flex items-center justify-center text-[10px] text-slate-500 p-2">
                Chưa cài số TK ngân hàng
              </div>
            )}

            <div className="text-[11px] font-bold text-black">
              {storeProfile.bankShortName || 'VCB'} · {storeProfile.bankAccountNumber || '0123456789'}
            </div>
            <div className="text-[11px] font-semibold uppercase text-slate-800">
              {storeProfile.bankAccountName || 'TAP HOA DUNG CANH'}
            </div>
            {finalTotal > 0 && (
              <div className="text-[10px] text-slate-700 mt-0.5 tabular-nums">
                Số tiền CK: {formatVND(finalTotal)} đ
              </div>
            )}

            <div className="text-[11px] font-semibold mt-2.5 pt-2 border-t border-dashed border-slate-300">
              {storeProfile.footerNote}
            </div>
          </div>
        </div>
      </div>

      {/* Primary Action Button: Print Thermal Receipt & Save Invoice */}
      {!readOnly && onPrintAndSave && (
        <div className="no-print pt-3 mt-3 border-t border-slate-200">
          <button
            type="button"
            disabled={items.length === 0 || isSaving}
            onClick={onPrintAndSave}
            className="w-full py-3 px-4 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white font-semibold text-sm rounded-xl flex items-center justify-center gap-2 transition-colors cursor-pointer"
          >
            <Printer className="w-4 h-4 shrink-0" />
            <span>
              {isSaving
                ? 'Đang lưu & chuẩn bị in...'
                : `Thanh Toán & In Hóa Đơn Giấy Nhiệt (${formatVND(finalTotal)} đ)`}
            </span>
          </button>
        </div>
      )}
    </div>
  );
};
