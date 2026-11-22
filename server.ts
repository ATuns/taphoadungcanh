import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  VIETNAM_BARCODE_CATALOG,
  GS1_BRAND_PREFIXES,
} from './src/data/vietnamBarcodes.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

async function queryUpcItemDb(
  barcode: string
): Promise<{ name: string; categories: string } | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(
      `https://api.upcitemdb.com/prod/trial/lookup?upc=${encodeURIComponent(barcode)}`,
      {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      items?: Array<{ title?: string; brand?: string; category?: string }>;
    };
    const first = data.items?.[0];
    if (first?.title) {
      return {
        name: first.title.trim().slice(0, 180),
        categories: first.category || '',
      };
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Endpoint: Automatic Barcode Product Lookup
  // 1. Instant match against curated Vietnamese grocery catalog
  // 2. Live query against OpenFoodFacts, OpenBeautyFacts, OpenProductsFacts, and UPCitemdb
  // 3. GS1 Vietnam / ASEAN manufacturer prefix intelligence
  app.post('/api/barcode/lookup', async (req, res) => {
    try {
      const rawBarcode = String(req.body?.barcode || '').trim();
      const barcode = rawBarcode.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);

      if (!barcode) {
        return res
          .status(400)
          .json({ error: 'Vui lòng cung cấp mã vạch hợp lệ.' });
      }

      // 1. Built-in Vietnamese grocery barcode catalog
      const catalogHit = VIETNAM_BARCODE_CATALOG[barcode];
      if (catalogHit) {
        return res.json({
          found: true,
          source: 'catalog_vn',
          sourceLabel: 'Danh mục chuẩn Tạp Hóa Việt Nam',
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

      // 2. Query OpenFoodFacts, OpenBeautyFacts, OpenProductsFacts, and UPCitemdb in parallel
      const [foodHit, beautyHit, productHit, upcHit] = await Promise.all([
        queryOpenFactsRegistry('world.openfoodfacts.org', barcode),
        queryOpenFactsRegistry('world.openbeautyfacts.org', barcode),
        queryOpenFactsRegistry('world.openproductsfacts.org', barcode),
        queryUpcItemDb(barcode),
      ]);

      const registryHit = foodHit || beautyHit || productHit || upcHit;
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

      // 3. Check GS1 Vietnam / ASEAN Manufacturer Prefix (e.g. 8934563 = Acecook, 8934673 = Vinamilk)
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

      // 4. Country prefix fallback template so user only needs to tweak name/price
      const countryHint = barcode.startsWith('893')
        ? 'Hàng Việt Nam'
        : barcode.startsWith('885')
          ? 'Hàng Thái Lan'
          : barcode.startsWith('880')
            ? 'Hàng Hàn Quốc'
            : barcode.startsWith('49') || barcode.startsWith('45')
              ? 'Hàng Nhật Bản'
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
      console.error('Barcode lookup error:', error);
      return res.status(500).json({
        error:
          error instanceof Error ? error.message : 'Lỗi khi tra cứu mã vạch.',
      });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Tạp Hóa Dung Cảnh POS Server running on http://localhost:${PORT}`
    );
  });
}

startServer();
