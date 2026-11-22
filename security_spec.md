# Security Specification: Tạp Hóa Dung Cảnh (POS & Barcode Inventory)

## 1. Data Invariants
1. **Strict Ownership Isolation**: Every document in `/products/{productId}` and `/invoices/{invoiceId}` belongs exclusively to its creator (`ownerId == request.auth.uid`). No authenticated user may read, list, modify, or delete another user's products or invoices.
2. **Verified Identity Enforcement**: All write operations (`create`, `update`, `delete`) require `request.auth != null && request.auth.token.email_verified == true`.
3. **Strict Key & Schema Blueprint**:
   - `Product` documents must contain only `['barcode', 'name', 'category', 'unit', 'price', 'costPrice', 'stock', 'source', 'ownerId', 'createdAt', 'updatedAt']`.
   - `Invoice` documents must contain only `['invoiceCode', 'tabName', 'customerName', 'itemsJson', 'itemCount', 'subtotal', 'discount', 'totalAmount', 'amountTendered', 'changeDue', 'paperWidth', 'ownerId', 'createdAt']`.
4. **Temporal & Identity Immutability**:
   - `createdAt` must equal `request.time` upon creation and cannot be mutated during updates.
   - `updatedAt` must equal `request.time` on creation and every update.
   - `ownerId` is immutable after creation.
   - `Invoice` documents are terminal receipts and cannot be updated after creation (`allow update: if false`).
5. **Path Variable & Volumetric Bounds**:
   - All single-document target path IDs (`productId`, `invoiceId`) must match `^[a-zA-Z0-9_\-]+$` with length `<= 128`.
   - Every string property enforces strict minimum and maximum character lengths matching `firebase-blueprint.json`.

## 2. The "Dirty Dozen" Payloads

1. **Identity Spoofing on Product Creation**: `ownerId: "victim-uid-999"` while authenticated as `"attacker-uid-111"`.
2. **Unverified Email Write**: Authenticated user with `email_verified: false` attempting to create a product.
3. **Shadow Field Injection on Product Create**: Adding `isAdmin: true` alongside valid product fields.
4. **Shadow Field Injection on Product Update**: Updating `price` while sneaking in `ghostField: "hacked"`.
5. **Immutable Field Mutation (`ownerId`)**: Updating a product to transfer `ownerId` to another user.
6. **Immutable Field Mutation (`createdAt`)**: Backdating `createdAt` during a product update.
7. **Forged Client Timestamp on Create**: Supplying a past or future `createdAt` timestamp not equal to `request.time`.
8. **Value Poisoning on Price/Stock**: Negative `price: -50000` or string `"free"` instead of a non-negative number.
9. **Resource Exhaustion / Oversized String**: Injecting a 10,000-character string into `name` (max 200) or `itemsJson` (max 4000).
10. **Path ID Poisoning**: Creating a document with an invalid ID containing spaces or special characters (`product$%^!`).
11. **Terminal State Mutation on Invoice**: Attempting an `update` operation on a finalized `/invoices/{invoiceId}` document.
12. **Cross-Tenant Query Scraping (`list`)**: Listing `/products` or `/invoices` without filtering `resource.data.ownerId == request.auth.uid`.
