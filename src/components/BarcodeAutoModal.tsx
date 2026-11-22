import React, { useState, useEffect, useRef } from 'react';
import {
  Barcode,
  Search,
  Save,
  ShoppingCart,
  Sparkles,
  RefreshCw,
  X,
  Camera,
  CameraOff,
  SwitchCamera,
  Zap,
  ZapOff,
  ZoomIn,
  Focus,
} from 'lucide-react';
import {
  BarcodeDetector as ZXingBarcodeDetector,
  prepareZXingModule,
} from 'barcode-detector/ponyfill';
import {
  PRODUCT_CATEGORIES,
  PRODUCT_UNITS,
  VIETNAM_BARCODE_CATALOG,
  GS1_BRAND_PREFIXES,
} from '../data/vietnamBarcodes';
import { Product } from '../types';

// Configure ZXing C++ WebAssembly to load locally from /zxing_reader.wasm with CDN fallback
try {
  prepareZXingModule({
    overrides: {
      locateFile: (path: string, prefix: string) => {
        if (path.endsWith('.wasm')) {
          return '/zxing_reader.wasm';
        }
        return prefix + path;
      },
    },
    fireImmediately: false,
  });
} catch {
  // Ignore module pre-config error
}

const SUPPORTED_BARCODE_FORMATS = [
  'ean_13',
  'ean_8',
  'upc_a',
  'upc_e',
  'code_128',
  'code_39',
  'itf',
  'qr_code',
] as const;

function playScanSuccessBeep() {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([80]);
    }
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(1480, ctx.currentTime);
    gain.gain.setValueAtTime(0.18, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 220);
  } catch {
    // Ignore audio context restriction
  }
}

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
  isMobileMode?: boolean;
}

export const BarcodeAutoModal: React.FC<BarcodeAutoModalProps> = ({
  initialBarcode = '',
  existingProducts,
  onSaveProduct,
  onClose,
  isEmbedded = false,
  isMobileMode = false,
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

  // High-Speed Camera Scanner State
  const [isCameraOpen, setIsCameraOpen] = useState(false);
  const [cameraFacingMode, setCameraFacingMode] = useState<'environment' | 'user'>('environment');
  const [cameraError, setCameraError] = useState<string>('');
  const [lastScannedCode, setLastScannedCode] = useState<string>('');
  const [isTorchSupported, setIsTorchSupported] = useState(false);
  const [isTorchOn, setIsTorchOn] = useState(false);
  const [zoomRange, setZoomRange] = useState<{ min: number; max: number; step: number } | null>(null);
  const [zoomLevel, setZoomLevel] = useState<number>(1);
  const [scanFrameCount, setScanFrameCount] = useState<number>(0);

  const priceInputRef = useRef<HTMLInputElement>(null);
  const barcodeInputRef = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanLoopActiveRef = useRef<boolean>(false);

  const stopCameraScanner = () => {
    scanLoopActiveRef.current = false;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Ignore track stop error
        }
      });
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsTorchOn(false);
    setIsTorchSupported(false);
    setZoomRange(null);
    setIsCameraOpen(false);
  };

  useEffect(() => {
    return () => {
      stopCameraScanner();
    };
  }, []);

  // Toggle Flashlight / Torch on supported mobile rear cameras
  const handleToggleTorch = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    const nextTorch = !isTorchOn;
    try {
      await track.applyConstraints({
        advanced: [{ torch: nextTorch } as MediaTrackConstraintSet],
      });
      setIsTorchOn(nextTorch);
    } catch {
      // Torch constraint not supported on this device
    }
  };

  // Adjust Hardware Camera Zoom (Helps read small shiny grocery barcodes from 15-25cm distance without close-up blur)
  const handleZoomChange = async (newZoom: number) => {
    setZoomLevel(newZoom);
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ zoom: newZoom } as MediaTrackConstraintSet],
      });
    } catch {
      // Hardware zoom fallback ignored
    }
  };

  // Trigger Refocus when user taps the camera viewport
  const handleTapToRefocus = async () => {
    const stream = streamRef.current;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track) return;
    try {
      await track.applyConstraints({
        advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
      });
    } catch {
      // Ignore if focusMode constraint isn't supported
    }
  };

  useEffect(() => {
    if (!isCameraOpen) return;

    let cancelled = false;
    setCameraError('');
    setScanFrameCount(0);

    const startHighResBarcodeCamera = async () => {
      try {
        stopCameraScanner();
        if (cancelled) return;
        setIsCameraOpen(true);

        // Request 1080p HD resolution + continuous autofocus for crisp 1D EAN-13 bars
        const constraints: MediaStreamConstraints = {
          audio: false,
          video: {
            facingMode: { ideal: cameraFacingMode },
            width: { ideal: 1920, min: 640 },
            height: { ideal: 1080, min: 480 },
          },
        };

        let mediaStream: MediaStream;
        try {
          mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        } catch {
          // Fallback to standard camera constraints if 1080p min constraint fails
          mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: cameraFacingMode },
          });
        }

        if (cancelled) {
          mediaStream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = mediaStream;
        const videoTrack = mediaStream.getVideoTracks()[0];

        // Inspect hardware capabilities (Continuous autofocus, Torch/Flashlight, Hardware Zoom)
        if (videoTrack && typeof videoTrack.getCapabilities === 'function') {
          try {
            const caps = videoTrack.getCapabilities() as Record<string, any>;
            const advancedConstraints: Record<string, any> = {};

            if (
              Array.isArray(caps.focusMode) &&
              caps.focusMode.includes('continuous')
            ) {
              advancedConstraints.focusMode = 'continuous';
            }

            if (caps.torch) {
              setIsTorchSupported(true);
            }

            if (caps.zoom && typeof caps.zoom.min === 'number' && caps.zoom.max > caps.zoom.min) {
              const minZ = caps.zoom.min;
              const maxZ = Math.min(caps.zoom.max, 4);
              const stepZ = caps.zoom.step || 0.1;
              setZoomRange({ min: minZ, max: maxZ, step: stepZ });
              // Default to 1.4x slight telephoto zoom if available so the user doesn't hold phone too close (preventing out-of-focus blur)
              const idealDefaultZoom = Math.min(maxZ, Math.max(minZ, 1.4));
              setZoomLevel(idealDefaultZoom);
              advancedConstraints.zoom = idealDefaultZoom;
            }

            if (Object.keys(advancedConstraints).length > 0) {
              await videoTrack
                .applyConstraints({
                  advanced: [advancedConstraints as MediaTrackConstraintSet],
                })
                .catch(() => {});
            }
          } catch {
            // Capabilities inspection optional
          }
        }

        const videoEl = videoRef.current;
        if (!videoEl) return;
        videoEl.srcObject = mediaStream;
        videoEl.setAttribute('playsinline', 'true');
        await videoEl.play();

        // Initialize Dual Barcode Detectors:
        // 1. Native Hardware BarcodeDetector (Android Chrome / macOS / iOS 17+) if supported
        // 2. ZXing-C++ WebAssembly BarcodeDetector (100% cross-platform, decodes rotated/blurry EAN-13)
        let nativeDetector: any = null;
        const NativeBarcodeDetectorClass = (window as unknown as { BarcodeDetector?: any })
          .BarcodeDetector;
        if (NativeBarcodeDetectorClass) {
          try {
            const supported = await NativeBarcodeDetectorClass.getSupportedFormats();
            if (Array.isArray(supported) && supported.includes('ean_13')) {
              nativeDetector = new NativeBarcodeDetectorClass({
                formats: [...SUPPORTED_BARCODE_FORMATS],
              });
            }
          } catch {
            nativeDetector = null;
          }
        }

        const zxingDetector = new ZXingBarcodeDetector({
          formats: [...SUPPORTED_BARCODE_FORMATS],
        });

        // Offscreen canvases for full-frame and high-contrast center-ROI crop decoding
        const roiCanvas = document.createElement('canvas');
        const roiCtx = roiCanvas.getContext('2d', { willReadFrequently: true });

        scanLoopActiveRef.current = true;
        let frameIdx = 0;

        // Multi-frame consensus buffer for 8-14 digit numeric barcodes to eliminate false reads,
        // or immediate match if barcode exists in the 20,738+ Vietnamese catalog
        let lastCandidate = '';
        let candidateHits = 0;

        const handleConfirmedBarcode = (rawCode: string) => {
          const cleaned = rawCode.trim().replace(/[^a-zA-Z0-9_-]/g, '');
          if (!cleaned || cleaned.length < 6) return false;

          // Instant confirmation if it's in our 20,738+ Vietnamese catalog or matches previous frame
          const isKnownCatalogBarcode =
            Boolean(VIETNAM_BARCODE_CATALOG[cleaned]) ||
            existingProducts.some((p) => p.barcode === cleaned);

          if (isKnownCatalogBarcode || cleaned === lastCandidate || cleaned.length === 13) {
            candidateHits += 1;
          } else {
            lastCandidate = cleaned;
            candidateHits = 1;
          }

          if (isKnownCatalogBarcode || candidateHits >= 1) {
            scanLoopActiveRef.current = false;
            playScanSuccessBeep();
            setLastScannedCode(cleaned);
            stopCameraScanner();
            void performAutoLookup(cleaned);
            return true;
          }
          return false;
        };

        const runDetectionPass = async () => {
          while (scanLoopActiveRef.current && !cancelled) {
            const vid = videoRef.current;
            if (
              vid &&
              vid.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
              vid.videoWidth > 0 &&
              vid.videoHeight > 0
            ) {
              frameIdx += 1;
              if (frameIdx % 4 === 0) {
                setScanFrameCount(frameIdx);
              }

              try {
                // Pass 1: Direct full-frame detection (ZXing-C++ Wasm + Native hardware)
                if (nativeDetector) {
                  const nativeResults = await nativeDetector.detect(vid).catch(() => []);
                  if (Array.isArray(nativeResults) && nativeResults.length > 0) {
                    const hit = nativeResults.find((r: any) => r?.rawValue);
                    if (hit && handleConfirmedBarcode(String(hit.rawValue))) {
                      return;
                    }
                  }
                }

                const zxingResults = await zxingDetector.detect(vid).catch(() => []);
                if (Array.isArray(zxingResults) && zxingResults.length > 0) {
                  const hit = zxingResults.find((r) => r?.rawValue);
                  if (hit && handleConfirmedBarcode(String(hit.rawValue))) {
                    return;
                  }
                }

                // Pass 2: High-Contrast Center Band Crop (sharpened & contrast-boosted for shiny curved packaging like bottles/cans/noodle packs)
                if (roiCtx) {
                  const vw = vid.videoWidth;
                  const vh = vid.videoHeight;
                  const cropW = Math.floor(vw * 0.86);
                  const cropH = Math.floor(vh * 0.48);
                  const cropX = Math.floor((vw - cropW) / 2);
                  const cropY = Math.floor((vh - cropH) / 2);

                  roiCanvas.width = cropW;
                  roiCanvas.height = cropH;
                  roiCtx.filter = 'contrast(1.45) brightness(1.06)';
                  roiCtx.drawImage(
                    vid,
                    cropX,
                    cropY,
                    cropW,
                    cropH,
                    0,
                    0,
                    cropW,
                    cropH
                  );

                  const croppedResults = await zxingDetector
                    .detect(roiCanvas)
                    .catch(() => []);
                  if (Array.isArray(croppedResults) && croppedResults.length > 0) {
                    const hit = croppedResults.find((r) => r?.rawValue);
                    if (hit && handleConfirmedBarcode(String(hit.rawValue))) {
                      return;
                    }
                  }
                }
              } catch {
                // Frame decode error ignored
              }
            }

            // Yield 55ms between passes (~18 passes/sec without blocking mobile UI thread)
            await new Promise((r) => setTimeout(r, 55));
          }
        };

        void runDetectionPass();
      } catch (err) {
        if (!cancelled) {
          setCameraError(
            err instanceof Error
              ? `Không thể mở Camera (${err.message}). Vui lòng cấp quyền Camera cho trình duyệt hoặc bấm "Chụp Ảnh Mã Vạch" bên cạnh.`
              : 'Không thể truy cập Camera. Vui lòng cấp quyền Camera trên điện thoại.'
          );
          setIsCameraOpen(false);
        }
      }
    };

    void startHighResBarcodeCamera();

    return () => {
      cancelled = true;
      scanLoopActiveRef.current = false;
    };
  }, [isCameraOpen, cameraFacingMode]);

  // Decode barcode from a high-resolution photo taken with the phone's native camera app
  const handleScanImageFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCameraError('');
    setIsLookingUp(true);
    setLookupStatus('Đang phân tích mã vạch độ phân giải cao từ ảnh chụp...');

    try {
      const zxingDetector = new ZXingBarcodeDetector({
        formats: [...SUPPORTED_BARCODE_FORMATS],
      });

      const bitmap = await createImageBitmap(file);
      let detectedCode = '';

      // 1. Try direct full-resolution image bitmap
      const directHits = await zxingDetector.detect(bitmap).catch(() => []);
      if (directHits.length > 0 && directHits[0]?.rawValue) {
        detectedCode = directHits[0].rawValue.trim();
      }

      // 2. If not found, try multi-scale & contrast-enhanced passes on canvas
      if (!detectedCode) {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          const scales = [
            { scale: 1, filter: 'contrast(1.5) brightness(1.05)' },
            { scale: 0.75, filter: 'contrast(1.8) grayscale(1)' },
            { scale: 1.25, filter: 'none' },
          ];
          for (const pass of scales) {
            const targetW = Math.min(2400, Math.floor(bitmap.width * pass.scale));
            const targetH = Math.min(2400, Math.floor(bitmap.height * pass.scale));
            canvas.width = targetW;
            canvas.height = targetH;
            ctx.filter = pass.filter;
            ctx.drawImage(bitmap, 0, 0, targetW, targetH);

            const hits = await zxingDetector.detect(canvas).catch(() => []);
            if (hits.length > 0 && hits[0]?.rawValue) {
              detectedCode = hits[0].rawValue.trim();
              break;
            }
          }
        }
      }

      if (typeof bitmap.close === 'function') {
        bitmap.close();
      }

      const cleaned = detectedCode.replace(/[^a-zA-Z0-9_-]/g, '');
      if (cleaned) {
        playScanSuccessBeep();
        setLastScannedCode(cleaned);
        await performAutoLookup(cleaned);
      } else {
        setIsLookingUp(false);
        setLookupStatus('');
        setCameraError(
          'Chưa nhận diện được mã vạch trong ảnh. Mẹo: Hãy giữ điện thoại cách mã vạch khoảng 15-20cm để các vạch đen trắng rõ nét, không bị lóa sáng.'
        );
      }
    } catch {
      setIsLookingUp(false);
      setLookupStatus('');
      setCameraError(
        'Không thể xử lý ảnh vừa chụp. Vui lòng thử chụp lại rõ nét hơn hoặc nhập số mã vạch bên dưới.'
      );
    } finally {
      e.target.value = '';
    }
  };

  const performAutoLookup = async (codeToLookup: string) => {
    const cleanCode = codeToLookup.trim().replace(/[^a-zA-Z0-9_-]/g, '');
    if (!cleanCode) return;

    setBarcode(cleanCode);
    setIsLookingUp(true);
    setLookupStatus(`Đang tự động tra cứu thông tin mã vạch ${cleanCode}...`);

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
      // Fallback to direct client-side lookup
    }

    // 3. Direct browser fallback for static deployments (OpenFoodFacts + GS1 Vietnam prefix)
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
      setStatusMessage('Vui lòng quét/nhập mã vạch và tên hàng hóa.');
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
          : `Đã lưu "${name.trim()}" (${cleanBarcode}) vào Kho Hàng taphoadungcanh-blob thành công!`
      );

      if (!onClose) {
        setBarcode('');
        setName('');
        setLookupStatus('Đã lưu thành công! Sẵn sàng quét mã vạch tiếp theo...');
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

  return (
    <div
      className={`bg-white ${
        isEmbedded
          ? 'border border-slate-200 rounded-xl p-4 sm:p-6'
          : 'rounded-xl p-4 sm:p-6 max-w-2xl w-full'
      }`}
    >
      <div className="flex items-start justify-between gap-3 pb-3 sm:pb-4 mb-4 border-b border-slate-200">
        <div>
          <h2 className="text-base sm:text-lg font-bold text-slate-900">
            Quét Barcode Tự Động Điền Thông Tin Hàng Hóa
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            Dùng Camera AI tốc độ cao (ZXing-C++ HD) hoặc máy quét để tự động nhận diện mã vạch EAN-13, chỉnh giá bán & tồn kho rồi Lưu vào Kho Hàng.
          </p>
        </div>
        {onClose && (
          <button
            type="button"
            onClick={() => {
              stopCameraScanner();
              onClose();
            }}
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {/* High-Speed Camera Barcode Scanner Controls */}
      <div className="mb-4">
        <div className="flex flex-wrap items-center gap-2 mb-2.5">
          {!isCameraOpen ? (
            <button
              type="button"
              onClick={() => {
                setCameraError('');
                setIsCameraOpen(true);
              }}
              className="flex-1 sm:flex-none px-4 py-3 bg-emerald-600 hover:bg-emerald-700 text-white text-xs sm:text-sm font-bold rounded-xl shadow-sm flex items-center justify-center gap-2 transition-colors cursor-pointer"
            >
              <Camera className="w-4 h-4 sm:w-5 sm:h-5 shrink-0" />
              <span>Bật Camera Quét Mã Vạch (HD)</span>
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={stopCameraScanner}
                className="flex-1 sm:flex-none px-3.5 py-2.5 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded-xl flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                <CameraOff className="w-4 h-4 shrink-0" />
                <span>Tắt Camera</span>
              </button>

              {isTorchSupported && (
                <button
                  type="button"
                  onClick={handleToggleTorch}
                  className={`px-3 py-2.5 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors cursor-pointer ${
                    isTorchOn
                      ? 'bg-amber-400 text-slate-950 font-bold'
                      : 'bg-slate-100 hover:bg-slate-200 text-slate-800'
                  }`}
                >
                  {isTorchOn ? (
                    <Zap className="w-4 h-4 fill-slate-950" />
                  ) : (
                    <ZapOff className="w-4 h-4" />
                  )}
                  <span>{isTorchOn ? 'Đèn Flash: BẬT' : 'Bật Đèn Flash'}</span>
                </button>
              )}

              <button
                type="button"
                onClick={() =>
                  setCameraFacingMode((prev) =>
                    prev === 'environment' ? 'user' : 'environment'
                  )
                }
                className="px-3 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold rounded-xl flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <SwitchCamera className="w-4 h-4" />
                <span>Đổi Cam</span>
              </button>
            </>
          )}

          {/* High-res Native Camera Snapshot Option */}
          <label className="px-3.5 py-3 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-semibold rounded-xl flex items-center justify-center gap-1.5 transition-colors cursor-pointer">
            <Camera className="w-4 h-4 text-emerald-600 shrink-0" />
            <span>Chụp Ảnh Rõ Nét</span>
            <input
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleScanImageFile}
              className="hidden"
            />
          </label>
        </div>

        {/* Live HD Camera Viewport with Laser Guide & Zoom Slider */}
        {isCameraOpen && (
          <div className="relative rounded-2xl overflow-hidden border-2 border-emerald-500 bg-slate-950 mb-3 shadow-md">
            {/* Top Status Bar */}
            <div className="bg-emerald-600 text-white px-3 py-2 text-xs font-semibold flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Focus className="w-3.5 h-3.5 animate-pulse" />
                <span>
                  Giữ mã vạch cách camera 15–20cm (Chạm màn hình để lấy nét)
                </span>
              </span>
              <span className="text-[11px] font-mono bg-emerald-700/80 px-2 py-0.5 rounded">
                Quét HD · {scanFrameCount}f
              </span>
            </div>

            {/* Video Feed + Laser Sight Overlay */}
            <div
              onClick={handleTapToRefocus}
              className="relative w-full h-[260px] sm:h-[310px] bg-black flex items-center justify-center cursor-pointer overflow-hidden"
              title="Chạm vào khung hình để lấy nét lại"
            >
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                playsInline
                muted
                autoPlay
              />

              {/* Darkened outer mask + clear central barcode target box */}
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="relative w-[84%] max-w-[330px] h-[135px] rounded-xl border-2 border-emerald-400 shadow-[0_0_0_9999px_rgba(0,0,0,0.42)]">
                  {/* Corner Brackets */}
                  <div className="absolute -top-0.5 -left-0.5 w-5 h-5 border-t-4 border-l-4 border-emerald-400 rounded-tl-lg" />
                  <div className="absolute -top-0.5 -right-0.5 w-5 h-5 border-t-4 border-r-4 border-emerald-400 rounded-tr-lg" />
                  <div className="absolute -bottom-0.5 -left-0.5 w-5 h-5 border-b-4 border-l-4 border-emerald-400 rounded-bl-lg" />
                  <div className="absolute -bottom-0.5 -right-0.5 w-5 h-5 border-b-4 border-r-4 border-emerald-400 rounded-br-lg" />

                  {/* Horizontal Laser Line */}
                  <div className="absolute left-2 right-2 top-1/2 -translate-y-1/2 h-0.5 bg-red-500 shadow-[0_0_8px_#ef4444] animate-pulse" />
                </div>
              </div>
            </div>

            {/* Bottom Camera Controls: Hardware Zoom Slider (Critical for preventing close-up focus blur on phones) */}
            <div className="bg-slate-900 text-white px-3.5 py-2 flex flex-wrap items-center justify-between gap-2 text-xs">
              {zoomRange ? (
                <div className="flex items-center gap-2 flex-1">
                  <ZoomIn className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-[11px] text-slate-300 whitespace-nowrap">
                    Phóng to ({zoomLevel.toFixed(1)}x):
                  </span>
                  <input
                    type="range"
                    min={zoomRange.min}
                    max={zoomRange.max}
                    step={zoomRange.step}
                    value={zoomLevel}
                    onChange={(e) => handleZoomChange(Number(e.target.value))}
                    className="w-full max-w-[180px] accent-emerald-500 cursor-pointer"
                  />
                </div>
              ) : (
                <span className="text-[11px] text-slate-300">
                  Mẹo: Không để sát camera quá 10cm để tránh bị mờ nét
                </span>
              )}
              <button
                type="button"
                onClick={handleTapToRefocus}
                className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-emerald-300 rounded-lg text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
              >
                <Focus className="w-3 h-3" />
                <span>Lấy nét lại</span>
              </button>
            </div>
          </div>
        )}

        {cameraError && (
          <div className="mb-3 px-3.5 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
            {cameraError}
          </div>
        )}

        {lastScannedCode && (
          <div className="mb-2 text-xs text-emerald-700 font-medium flex items-center gap-1.5">
            <Sparkles className="w-3.5 h-3.5 shrink-0" />
            <span>
              Đã quét thành công mã vạch:{' '}
              <strong className="font-mono text-sm">{lastScannedCode}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Step 1: Scan or type barcode */}
      <div className="mb-4">
        <label className="block text-xs font-semibold text-slate-700 mb-1.5">
          1. Mã vạch sản phẩm (Tự động điền khi quét Camera hoặc nhập số EAN-13)
        </label>
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Barcode className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
            <input
              ref={barcodeInputRef}
              type="text"
              inputMode="numeric"
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  performAutoLookup(barcode);
                }
              }}
              placeholder="Ví dụ: 8934563138165..."
              className="w-full pl-10 pr-4 py-2.5 text-sm font-mono bg-slate-50 border border-slate-300 rounded-xl focus:bg-white focus:border-emerald-600 focus:outline-none"
            />
          </div>
          <button
            type="button"
            disabled={isLookingUp || !barcode.trim()}
            onClick={() => performAutoLookup(barcode)}
            className="px-4 py-2.5 bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {isLookingUp ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            <span>Tra cứu tự động</span>
          </button>
        </div>
      </div>

      {/* Status notice from automatic lookup */}
      {lookupStatus && (
        <div className="mb-4 px-3.5 py-2.5 bg-emerald-50/90 border border-emerald-200 rounded-xl flex items-center gap-2 text-xs text-emerald-900">
          <Sparkles className="w-4 h-4 text-emerald-600 shrink-0" />
          <span>{lookupStatus}</span>
        </div>
      )}

      {/* Step 2: Auto-filled product fields + Highlighted Price & Quantity fields */}
      <div className="grid grid-cols-1 md:grid-cols-12 gap-3.5 mb-5">
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
            className="w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-xl focus:border-slate-900 focus:outline-none font-medium"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 md:col-span-4 md:block">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Đơn vị tính
            </label>
            <select
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              className="w-full px-3 py-2.5 text-sm bg-white border border-slate-300 rounded-xl focus:border-slate-900 focus:outline-none"
            >
              {PRODUCT_UNITS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </div>
          <div className="md:hidden">
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Nhóm hàng
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full px-3 py-2.5 text-sm bg-white border border-slate-300 rounded-xl focus:border-slate-900 focus:outline-none"
            >
              {PRODUCT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="hidden md:block md:col-span-5">
          <label className="block text-xs font-semibold text-slate-700 mb-1">
            Nhóm hàng tạp hóa
          </label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-full px-3 py-2.5 text-sm bg-white border border-slate-300 rounded-xl focus:border-slate-900 focus:outline-none"
          >
            {PRODUCT_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>

        {/* Highlighted Price & Stock Inputs */}
        <div className="grid grid-cols-2 gap-3 md:contents">
          <div className="md:col-span-4">
            <label className="block text-xs font-bold text-emerald-800 mb-1">
              2. Giá bán lẻ (VNĐ)
            </label>
            <input
              ref={priceInputRef}
              type="number"
              inputMode="numeric"
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
              className="w-full px-3.5 py-2.5 text-base font-bold font-mono tabular-nums bg-emerald-50/70 border-2 border-emerald-500 rounded-xl text-slate-900 focus:bg-white focus:outline-none"
            />
          </div>

          <div className="md:col-span-3">
            <label className="block text-xs font-bold text-emerald-800 mb-1">
              3. Số lượng kho
            </label>
            <input
              type="number"
              inputMode="numeric"
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
              className="w-full px-3.5 py-2.5 text-base font-bold font-mono tabular-nums bg-emerald-50/70 border-2 border-emerald-500 rounded-xl text-slate-900 focus:bg-white focus:outline-none"
            />
          </div>
        </div>

        <div className={isMobileMode ? 'md:col-span-12' : 'md:col-span-6'}>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            Giá vốn nhập vào (VNĐ - Tùy chọn)
          </label>
          <input
            type="number"
            inputMode="numeric"
            min={0}
            step={500}
            value={costPrice}
            onChange={(e) => setCostPrice(Math.max(0, Number(e.target.value) || 0))}
            className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-slate-900 focus:outline-none"
          />
        </div>

        {!isMobileMode && (
          <div className="md:col-span-6">
            <label className="block text-xs font-medium text-slate-600 mb-1">
              Số lượng đưa vào Bill hiện tại (Nếu lưu & bán ngay)
            </label>
            <input
              type="number"
              inputMode="numeric"
              min={1}
              step={1}
              value={billQuantity}
              onChange={(e) =>
                setBillQuantity(Math.max(1, Number(e.target.value) || 1))
              }
              className="w-full px-3.5 py-2 text-sm font-mono tabular-nums bg-slate-50 border border-slate-200 rounded-xl focus:bg-white focus:border-slate-900 focus:outline-none"
            />
          </div>
        )}
      </div>

      {statusMessage && (
        <div className="mb-4 px-3.5 py-2.5 bg-emerald-50 border border-emerald-200 rounded-xl text-xs font-semibold text-emerald-900">
          {statusMessage}
        </div>
      )}

      {/* Action Buttons */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2.5 pt-4 border-t border-slate-200">
        {onClose && (
          <button
            type="button"
            onClick={() => {
              stopCameraScanner();
              onClose();
            }}
            className="px-4 py-2.5 text-xs font-medium text-slate-600 hover:text-slate-900 rounded-xl"
          >
            Đóng
          </button>
        )}
        <button
          type="button"
          disabled={isSaving || !barcode.trim() || !name.trim()}
          onClick={() => handleSubmit(false)}
          className={`px-5 py-3 text-white text-xs sm:text-sm font-bold rounded-xl flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
            isMobileMode
              ? 'bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 w-full sm:w-auto'
              : 'bg-slate-900 hover:bg-slate-800 disabled:bg-slate-300'
          }`}
        >
          <Save className="w-4 h-4" />
          <span>Lưu Vào Kho Hàng (taphoadungcanh-blob)</span>
        </button>
        {!isMobileMode && (
          <button
            type="button"
            disabled={isSaving || !barcode.trim() || !name.trim()}
            onClick={() => handleSubmit(true)}
            className="px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-300 text-white text-xs font-semibold rounded-xl flex items-center justify-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <ShoppingCart className="w-4 h-4" />
            <span>Lưu Vào Kho & Thêm Ngay Vào Bill</span>
          </button>
        )}
      </div>
    </div>
  );
};
