# Image Pipeline — Frontend Codebase Audit (Phase 1)

**Status:** Read-only reconciliation, no code modified
**Date:** 2026-05-07
**Companion docs:** `IMAGE-PIPELINE-SPEC.md` (master spec), `IMAGE-PIPELINE-WORKER-NEEDS-FRONTEND.md` (Phase 2 output)

This is the inventory of how the current frontend handles images. Every claim is cited with `file:line`. Used as ground truth for the Phase 2 Worker-contract document.

---

## 1. Image upload flow today

### 1.A Product image upload

- **File picker UI:** `src/components/client/ImagesImport.tsx:32-56`
  - Accepts `image/*` multiple, max 5 per request (line 38), warns via toast if exceeded
- **Handler:** `src/lib/service/reactCalls/productService.ts:12-30` (`extractAndUploadImages`)
  - Maps over `productData.imagesData`, calls `uploadToCloudflare({ file })` per file
  - Returns `string[]` of image keys
- **Network upload:** `src/lib/service/reactCalls/cloudflareService.ts:30-43` (`uploadToCloudflare`)
  - Calls `POST /secure/direct-upload` on backend → `{ token, key }`
  - Then `uploadToCloudflareInternal(token, key, file)` (lines 110-139)
- **Token request:**
  - Endpoint: `POST {BACKEND_API}/secure/direct-upload`
  - Headers: Bearer Firebase JWT + cookies
  - Response: `{ token: string, key: string }` — token is backend-issued
- **Upload PUT:**
  - URL: `${WORKER_URL}/${folder}${key}` where `WORKER_URL = process.env.NEXT_PUBLIC_CDN_URL`
  - Header: `x-upload-token: <token>` (only)
  - Body: `FormData` with `file` field appended raw (`cloudflareService.ts:117`)
- **Batch flow:** `cloudflareService.ts:46-67` (`uploadBatchParallel`)
  - `POST /secure/direct-upload-batch` body `{ count: files.length }`
  - Returns `Array<{ token, key }>`, then 1:1 maps tokens to files, uploads in parallel
- **Size validation:** `src/lib/validators/productValidator.ts:224`
  - Constant: `5 * 1024 * 1024` (5 MB)
  - Error key: `image.too.big`
  - Also checks SHA-256 duplicate detection (line 229-236) → `image.duplicate`
- **Browser-side processing:** **None.** Files uploaded raw — no resize, compress, or format conversion.
- **What is stored:** `data.fileName` returned from PUT response (line 138). Product create stores raw key in `imageKeys: string[]` on `NewProductRequestDTO` (`src/lib/types/product/NewProductRequestDTO.ts:18`). Stored value example: `["uuid-1", "uuid-2"]` — raw UUID, no prefix.

### 1.B Profile picture upload

- **File picker:** `src/components/owner/client/AvatarUpload.tsx:27-35` (`handleFileSelect`)
  - Accepts single `image/*`
- **Handler:** `app/[locale]/owner/user/page.tsx:101-147` (`saveChanges`)
  - If `avatarFile` set → `uploadToCloudflare({ file: avatarFile })` (line 143)
  - Returns single key, sent to `updateUser()` (line 156)
- **Upload flow:** Identical to product single upload (uses `uploadToCloudflare`)
- **Size validation:** Same 5 MB limit (no avatar-specific cap)

### 1.C Chat attachment upload

- **File picker:** `src/messages/components/MessageInput.tsx:70-86`
  - Accepts `image/*` multiple, max 5 per message (line 20: `MAX_NUMBER_OF_IMAGES_PER_MESSAGE`)
- **Handler:** `MessageInput.tsx:94-99`
  - Calls `uploadChatImagesBatchParallel({ files: images, chatId })`
- **Service:** `cloudflareService.ts:69-90`
  - `POST /secure/direct-upload-batch` body `{ count, chatId }` (line 72-74)
  - **Difference from product:** request includes `chatId`
  - Maps tokens to files, uploads with `folder: 'chat-images'` (line 86)
  - Returns array of keys
- **Worker URL:** Same Worker, but path is `${WORKER_URL}/chat-images/${key}`

### 1.D Product review image upload

- **File picker:** `src/components/popups/components/ProductReviewImageImport.tsx:27-42`
  - Accepts `image/*` multiple, max 5 (line 8)
- **Handler:** Line 39 stores files in parent state
- **Service:** `src/lib/service/reactCalls/reviewService.ts:63-91` (`reviewProduct`)
  - Maps over `data.images`, calls `uploadToCloudflare({ file })` for each (line 68)
  - Returns array of keys, sent to backend `/secure/review/product` (line 80)

---

## 2. Image display today

### 2.A Product card thumbnails

- **Component:** `src/components/client/product/ProductTopImage.tsx:24-50`
- **JSX:**
  ```tsx
  const src = typeof topImage === 'string'
    ? getImageForKey(topImage)
    : URL.createObjectURL(topImage);
  <img src={src} alt={productName} className="h-full w-full object-cover" loading="lazy" />
  ```
- **URL construction:** `getImageForKey(key)` returns `${WORKER_URL}/${key}`
- **Tag:** plain `<img>` (NOT `next/image`)
- **Size:** `w-full h-full object-cover` (fills card)
- **Used by:** `src/components/client/product/UniversalProductCard.tsx:69`
- **Error handling:** `onError={() => setError(true)}` (line 37) → shows `<OglasinoIcon>` placeholder

### 2.B Product detail carousel (hero)

- **Component:** `src/components/client/ProductImageCarusel.tsx:56-60, 82-89`
- **JSX:**
  ```tsx
  <img
    src={getImageForKey(imageKeys[visibleIndex])}
    alt="Product"
    className="h-[50vh] min-h-100 w-full rounded-md object-contain sm:min-h-125 xl:h-[70vh]"
  />
  ```
- **Sizes:** mobile `h-[50vh]`, tablet `min-h-125`, desktop `xl:h-[70vh]`
- **Fallback:** `<OglasinoIcon>` if no images

### 2.C Lightbox / fullscreen viewer

- **Component:** `src/components/client/FullscreenViewer.tsx:57-61` (main), `:75-83` (thumbnails)
- **JSX:**
  ```tsx
  <img
    src={getImageForKey(imageKeys[visibleIndex])}
    alt="Fullscreen product"
    className="max-h-[90vh] max-w-[90vw] object-contain"
  />
  ```
- **Sizes:** thumbs `h-16 w-16`, main `max-h-[90vh] max-w-[90vw]`

### 2.D Chat message thumbnails

- **Component:** `src/messages/components/MessageImages.tsx:60-70`
- **JSX:**
  ```tsx
  const images = imageKeys.map((key) =>
    getChatImageForKey(chatId, key, viewToken)
  );
  <img src={images[0]} alt="" className="h-20 w-auto rounded-md" onClick={...} />
  ```
- **URL construction:** `getChatImageForKey(activeChatId, key, viewToken)` returns
  ```
  ${WORKER_URL}/chat-images/${activeChatId}/${key}?token=${viewToken}
  ```
  (`cloudflareService.ts:25-26`)
- **Size:** `h-20 w-auto`

### 2.E Product review images

- **Component:** `src/components/client/product/ProductReview.tsx:65, 77`
- **JSX:**
  ```tsx
  <img src={getImageForKey(review.imageKeys[0])} alt="" />
  ```
- **Size:** `w-[30%]` of container (line 63)
- **Lightbox:** uses `<FullscreenViewer>` with `imageKeys`

### 2.F Avatar / profile picture

- **Component:** `src/components/server/OglasinoAvatar.tsx:33-39`
- **JSX:**
  ```tsx
  const getImage = () => {
    if (profileImageKey.startsWith('blob') || profileImageKey.startsWith('http')) {
      return profileImageKey;
    }
    return getImageForKey(profileImageKey);
  };
  <AvatarImage src={profileImageKey ? getImage() : ''} alt={displayName} />
  ```
- **Sizes:** Tailwind `size-9` to `size-20` (varies by usage)
- **Fallback:** colored initial letter

### 2.G `next.config.ts` `images.remotePatterns`

- **Status:** **NOT CONFIGURED.** No `images` key in Next config.
- **Implication:** App does NOT use `next/image`; only plain `<img>` tags.

### 2.H Image URL helper

- **Function:** `src/lib/service/reactCalls/cloudflareService.ts:21-23`
  ```ts
  export const getImageForKey = (key: string) => {
    return `${WORKER_URL}/${key}`;
  };
  ```
- **Takes:** raw key (e.g., `uuid-123`)
- **Returns:** full URL `https://cdn.oglasino.com/uuid-123`
- **Used for:** product, avatar, review images
- **Chat images use a separate helper:** `getChatImageForKey` (line 25-26)
- **No variant / no resize logic** — single helper, direct R2 access only.

---

## 3. Chat image flow

### 3.A Upload differences vs product

- **Endpoint:** Same backend `/secure/direct-upload-batch`, but request includes `chatId`:
  ```ts
  POST /secure/direct-upload-batch
  Body: { count: number, chatId: string }
  ```
- **Folder:** files uploaded with `folder: 'chat-images'` (line 86)
- **Final URL on Worker:** `https://cdn.oglasino.com/chat-images/{chatId}/{key}`

### 3.B View token request

- **When called:** `MessageImages.tsx:28-35`
  ```ts
  useEffect(() => { fetchViewToken() }, [chatId])
  ```
  → on component mount, once per chat open
- **Service call:** `cloudflareService.ts:92-104` (`getViewChatImagesToken`)
  ```ts
  POST /secure/view-token
  Body: { chatId }
  Response: { token: string }
  ```

### 3.C Token caching

- **Stored in:** local React state `const [viewToken, setViewToken] = useState('')` (line 24)
- **Type:** in-memory only (component-level)
- **Persistence:** none — no localStorage, no Zustand store, no cookies
- **Revalidation:** on image load error (line 49: `await fetchViewToken()`)
- **Retry logic:** max 2 retries (line 45: `if (retryKey > 2) return`)

### 3.D View token in URL

- **Construction:** `cloudflareService.ts:25-26`
  ```ts
  export const getChatImageForKey = (activeChatId, key, viewToken) =>
    `${WORKER_URL}/chat-images/${activeChatId}/${key}?token=${viewToken}`;
  ```
- **Format:** `https://cdn.oglasino.com/chat-images/abc-123/uuid-456?token=signed-token`
- **Routing:** direct to Worker — NOT proxied through backend

---

## 4. Existing libraries

In `package.json`:

- `sharp: ^0.34.5` — server-side image processing (build scripts only, NOT in browser)
- `firebase: ^12.6.0` — includes Firebase Storage SDK, **initialized but NOT used** for images

**NOT installed:**
- `browser-image-compression`
- `heic2any`
- `compressorjs`, `pica`, `image-blob-reduce`
- `react-image-crop`, `react-easy-crop`

**Browser image processing:** None. Confirms spec assumption that Track 4 (browser-side pipeline) is greenfield.

---

## 5. Component patterns

### 5.A Reusable upload component

**Yes — one exists:**
- **Path:** `src/components/client/ImagesImport.tsx`
- **Name:** `ImagesImport`
- **Props:**
  ```ts
  images: ImageData[] | undefined;
  setImages: (images: ImageData[]) => void;
  visibleImage: ImageData | undefined;
  setVisibleImage: (image: ImageData | undefined) => void;
  maxNumberOfImages: number;
  disabled?: boolean;
  ```
- **Used by:** `src/components/popups/components/ImageSelectionProductDialog.tsx:52-58`
- **Scope:** file-picker UI + preview only — does NOT do the actual upload (caller handles via `extractAndUploadImages`)

### 5.B Reusable display component

**No.** Image rendering done inline using `getImageForKey()`. `<img>` tags scattered across `ProductTopImage`, `ProductImageCarusel`, `FullscreenViewer`, `OglasinoAvatar`, `ProductReview`, `MessageImages`.

### 5.C Loading states

- **No explicit progress bar** during upload
- **Product upload:** `<LoadingOverlay>` shown only AFTER upload completes, during the backend POST in `UploadedProductDialog.tsx:67-71`
- **Chat:** no upload-time loading indicator
- **Loading component:** `src/components/popups/components/LoadingOverlay.tsx`
  - Oglasino icon + "Loading..." text + animated dots
  - `inline?: boolean` prop — scoped (`absolute`) vs full viewport (`fixed inset-0`)

### 5.D Error handling

**Upload:**
- Caught in try/catch, logged to console
- `productService.ts:19-23` returns empty string on fail
- Validation errors inline: `setErrorMessage(tErrors('image.not.good'))` (`ProductReviewImageImport.tsx:76`)
- Toast for max-images warning (`ImagesImport.tsx:39-44`)

**Display:**
- Broken image fallback via `onError` handler → `<OglasinoIcon>` placeholder (`ProductTopImage.tsx:37`)

---

## 6. Translation keys

Image-related keys currently in use:

| Key | Namespace | File:line | Usage |
|---|---|---|---|
| `image.max` | INPUT | `ProductReviewImageImport.tsx:34` | "Max {value} images" toast |
| `image.not.good` | ERRORS | `ProductReviewImageImport.tsx:76` | Image fails to load in preview |
| `image.too.big` | (validator) | `productValidator.ts:225` | File > 5 MB |
| `image.duplicate` | (validator) | `productValidator.ts:232` | SHA-256 duplicate detected |
| `image.broke` | INPUT | `ImagesImport.tsx:123` | Alt text for broken image preview |
| `max.images.alert` | MESSAGES_PAGE | `MessageInput.tsx:79` | Chat max-images warning |
| `max.images.label` | MESSAGES_PAGE | `MessageInput.tsx:190` | Chat image icon tooltip |
| `images.holder.label` | BUTTONS | `ImagesImport.tsx:97` | "Drop images here" placeholder |
| `images.import` | BUTTONS | `ImagesImport.tsx:152` | "Import images" button |
| `new.product.image.suggestion` | DIALOG | `ImageSelectionProductDialog.tsx:49` | Suggestion text |
| `new.product.image.advice` | DIALOG | `ImageSelectionProductDialog.tsx:59` | Advice text |
| `new.product.image.step.forward` | DIALOG | `ImageSelectionProductDialog.tsx:62` | Button label |
| `add.images.label` | DIALOG | `ProductReviewImageImport.tsx:50` | "Add images" heading for reviews |
| `review.image.upload.suggestion.2` | INPUT | `ProductReviewImageImport.tsx:91-93` | Suggestion text |

**Namespace structure:**
- Translations fetched dynamically from backend: `GET /public/translations?namespace={ns}&lang={lang}`
- Existing namespaces: `INPUT`, `DIALOG`, `MESSAGES_PAGE`, `ERRORS`, `BUTTONS`, ...
- Format: flat dot-separated keys (`image.max`, `image.too.big`)
- **Translations are NOT in repo JSON files** — fetched via `unstable_cache`-wrapped backend call (see `src/translations/lib/translationsCache.ts`)

---

## 7. Anything else worth flagging

### 7.A CDN URL is env-driven (good)

- `.env.local.example:16`: `NEXT_PUBLIC_CDN_URL=https://cdn.oglasino.com`
- Used as `process.env.NEXT_PUBLIC_CDN_URL` (`cloudflareService.ts:3`)
- **Risk:** if env var missing, `WORKER_URL` is `undefined`, uploads fail silently with malformed URL.

### 7.B Backend proxy pattern for tokens (good — keep)

- All token operations go through backend `/secure/*` endpoints
- Backend adds: `X-Base-Site`, `X-Lang`, `Authorization` (`src/lib/config/api.ts:61-74`)
- `withCredentials: true` for cookies (`api.ts:16`)
- Spec / Phase 2 confirms keeping this pattern.

### 7.C CORS

- **No explicit Worker-side CORS handling visible to frontend** (handled in Worker code, not the Next app)
- **Server Actions origin allowlist:** `next.config.ts:18-19` (`experimental.serverActions.allowedOrigins`) — current values: `oglasino.com`, `www.oglasino.com`, `oglasino-web.vercel.app`. Reuse this list for Worker CORS allowlist.

### 7.D Firebase Storage initialized but unused

- Initialized in `src/lib/config/firebaseClient.ts:10, 35`
- **No fallback to Firebase Storage exists** — all images go to Cloudflare R2 only
- If the Worker is down, all images fail — no silent fallback path
- Cruft worth removing or documenting

### 7.E No HEIC / AVIF browser conversion (confirms spec)

- All files uploaded raw with `accept="image/*"` (which the browser interprets as any image, including HEIC on iOS)
- No canvas usage anywhere image-relevant
- No WebAssembly modules
- **Implication for Worker contract:** must accept HEIC for now, or contract dictates Track 4 ships before Track 0 enforcement

### 7.F Hardcoded limits

- Max 5 images per product (implicit, hardcoded as `maxNumberOfImages` prop)
- Max 5 chat attachments per message (`MessageInput.tsx:20`)
- Max 5 review images (`ProductReviewImageImport.tsx:8`)
- Max 5 MB file size (`productValidator.ts:224`)

### 7.G Auth flow summary

| Flow | Step | Detail |
|---|---|---|
| Product upload | 1 | Browser → Backend `/secure/direct-upload` (Bearer Firebase JWT) |
| | 2 | Backend → Worker (server-to-server) for signed token |
| | 3 | Backend → Browser: `{ token, key }` |
| | 4 | Browser → Worker `PUT /{key}` with `x-upload-token` |
| Chat upload | 1 | Same as product, but request body includes `chatId` |
| Chat view | 1 | Browser → Backend `/secure/view-token` body `{ chatId }` |
| | 2 | Backend → Browser: `{ token }` |
| | 3 | Browser appends `?token=` to image URL: `<img src=...?token=...>` |

### 7.H Aspect ratios / sizing notes

- Product cards: `object-cover` (fills, crops to ratio)
- Product detail: `object-contain` (preserves aspect)
- Chat thumbnails: `h-20 w-auto` (auto width)
- Avatars: `size-N` square circle

### 7.I No frontend resizing — variants must come from CDN

- No `width` / `height` props on `<img>` tags
- No `srcset` anywhere
- Lazy loading via `loading="lazy"` only
- **Track 2 (Cloudflare Image Resizing) is the only mechanism** for serving responsive sizes

### 7.J Translation keys are dynamic (backend-driven)

- Keys NOT hardcoded in repo as JSON
- Loaded via `next-intl` from backend
- Missing key → falls back to key string in production, throws in dev
- Adding new keys (Phase 2 §H.7) requires backend translation table updates, not just frontend changes

---

## Summary table — what frontend sends to Worker today

| Flow | URL | Method | Headers | Query | Body |
|---|---|---|---|---|---|
| Public/Avatar/Review upload | `${WORKER_URL}/${key}` | PUT | `x-upload-token: <token>` | — | `FormData(file)` |
| Chat upload | `${WORKER_URL}/chat-images/${key}` | PUT | `x-upload-token: <token>` | — | `FormData(file)` |
| Public image fetch | `${WORKER_URL}/${key}` | GET | — | — | — |
| Chat image fetch | `${WORKER_URL}/chat-images/${chatId}/${key}` | GET | — | `token=<viewToken>` | — |
| Token request (single) | `${BACKEND}/secure/direct-upload` | POST | Bearer JWT + cookies | — | empty / implicit |
| Token request (batch) | `${BACKEND}/secure/direct-upload-batch` | POST | Bearer JWT + cookies | — | `{ count, chatId? }` |
| View token request | `${BACKEND}/secure/view-token` | POST | Bearer JWT + cookies | — | `{ chatId }` |

## Summary table — what frontend expects back

| Flow | Response |
|---|---|
| Upload PUT | `{ fileName: string }` (today — frontend wants `{ key, publicUrl?, bytes, contentType }` per Phase 2) |
| Token (single) | `{ token: string, key: string }` |
| Token (batch) | `Array<{ token: string, key: string }>` |
| View token | `{ token: string }` (today — frontend wants `{ token, expiresAt, scope, chatId }` per Phase 2) |
| Image GET | image bytes |

---

**End of Phase 1 audit.** Goes into Phase 2 design (`IMAGE-PIPELINE-WORKER-NEEDS-FRONTEND.md`) and ultimately into the unified Worker contract.
