import QRCode from 'qrcode';

export interface BankQrConfig {
  enabled: boolean;
  bankBin: string;
  bankShortName: string;
  accountNumber: string;
  accountName: string;
  transferTemplate: string;
  customQrDataUrl?: string;
}

export const VIETNAM_BANKS: Array<{
  bin: string;
  shortName: string;
  fullName: string;
}> = [
  { bin: '970436', shortName: 'VCB', fullName: 'Vietcombank - Ngân hàng Ngoại thương VN' },
  { bin: '970415', shortName: 'ICB', fullName: 'VietinBank - Ngân hàng Công thương VN' },
  { bin: '970418', shortName: 'BIDV', fullName: 'BIDV - Ngân hàng Đầu tư & Phát triển VN' },
  { bin: '970405', shortName: 'VBA', fullName: 'Agribank - Ngân hàng NN & PT Nông thôn VN' },
  { bin: '970422', shortName: 'MB', fullName: 'MBBank - Ngân hàng Quân Đội' },
  { bin: '970407', shortName: 'TCB', fullName: 'Techcombank - Ngân hàng Kỹ thương VN' },
  { bin: '970416', shortName: 'ACB', fullName: 'ACB - Ngân hàng Á Châu' },
  { bin: '970432', shortName: 'VPB', fullName: 'VPBank - Ngân hàng Việt Nam Thịnh Vượng' },
  { bin: '970403', shortName: 'STB', fullName: 'Sacombank - Ngân hàng Sài Gòn Thương Tín' },
  { bin: '970423', shortName: 'TPB', fullName: 'TPBank - Ngân hàng Tiên Phong' },
  { bin: '970437', shortName: 'HDB', fullName: 'HDBank - Ngân hàng Phát triển TP.HCM' },
  { bin: '970441', shortName: 'VIB', fullName: 'VIB - Ngân hàng Quốc Tế' },
  { bin: '970443', shortName: 'SHB', fullName: 'SHB - Ngân hàng Sài Gòn - Hà Nội' },
  { bin: '970448', shortName: 'OCB', fullName: 'OCB - Ngân hàng Phương Đông' },
  { bin: '970426', shortName: 'MSB', fullName: 'MSB - Ngân hàng Hàng Hải VN' },
  { bin: '970454', shortName: 'VCCB', fullName: 'BVBank - Ngân hàng Bản Việt' },
];

function tlv(id: string, value: string): string {
  const len = value.length.toString().padStart(2, '0');
  return `${id}${len}${value}`;
}

function crc16Ccitt(str: string): string {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Generates an official Napas 247 VietQR EMVCo string so any Vietnamese banking app
 * (Vietcombank, MB, Techcombank, BIDV, Agribank, VietinBank, MoMo, ZaloPay...)
 * can scan the printed thermal receipt and auto-fill Bank, Account Number, Amount, and Note!
 */
export function buildVietQrEmvPayload(params: {
  bankBin: string;
  accountNumber: string;
  amount?: number;
  addInfo?: string;
}): string {
  const cleanAccount = params.accountNumber.trim();
  const cleanBin = params.bankBin.trim() || '970436';
  const amountVal = params.amount && params.amount > 0 ? Math.round(params.amount) : 0;

  // GUID for NAPAS
  const guid = tlv('00', 'A000000727');
  // Beneficiary organization (Bank BIN + Account Number)
  const memberBank = tlv('00', cleanBin) + tlv('01', cleanAccount);
  const serviceCode = tlv('02', 'QRIBFTTA');
  const consumerAccountInfo = tlv('38', guid + tlv('01', memberBank) + serviceCode);

  let payload =
    tlv('00', '01') + // Payload Format Indicator
    tlv('01', amountVal > 0 ? '12' : '11') + // Dynamic (12) if amount > 0 else Static (11)
    consumerAccountInfo +
    tlv('53', '704'); // VND currency code

  if (amountVal > 0) {
    payload += tlv('54', String(amountVal));
  }

  payload += tlv('58', 'VN');

  if (params.addInfo && params.addInfo.trim()) {
    const cleanNote = params.addInfo
      .trim()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .replace(/[^a-zA-Z0-9 -]/g, '')
      .slice(0, 25);
    if (cleanNote) {
      payload += tlv('62', tlv('08', cleanNote));
    }
  }

  const payloadWithCrcHeader = `${payload}6304`;
  const crc = crc16Ccitt(payloadWithCrcHeader);
  return `${payloadWithCrcHeader}${crc}`;
}

export async function generateVietQrDataUrl(params: {
  bankBin: string;
  accountNumber: string;
  amount?: number;
  addInfo?: string;
}): Promise<string> {
  if (!params.accountNumber.trim()) return '';
  const emvPayload = buildVietQrEmvPayload(params);
  try {
    return await QRCode.toDataURL(emvPayload, {
      width: 220,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF',
      },
      errorCorrectionLevel: 'M',
    });
  } catch (err) {
    console.error('QR generation error:', err);
    return '';
  }
}
