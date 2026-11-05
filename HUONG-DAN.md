# Hanami Sushi Bar – hướng dẫn triển khai

Apps Script + GitHub + Vercel + máy in Epson TM-m30III

## Checklist triển khai

| # | Việc | Ai | Xong khi |
|---|---|---|---|
| 0 | Chrome profile riêng + bật Apps Script API | Bạn | — |
| 1 | Push repo lên GitHub | Bạn | `npm test` 15 tester OK |
| 2 | Sheet + Apps Script: `setup`, Skriptegenskaper, Distribuera webbapp | Bạn | Menu **Hanami** xuất hiện |
| 3 | Vercel: env, deploy, Deploy Hook | Bạn | `/api/health` → `"ok": true` |
| 4 | GitHub Actions secrets | Bạn | Action "Apps Script" xanh |
| 5 | Máy in TM-m30III | Bạn + quán | Testbeställning in ra |
| 6 | Tên miền | Bạn + quán | `https://hanamisushibar.se` mở web mới |
| 7 | In QR bàn, cài `/kok` trên iPad, hướng dẫn nhân viên | Quán | Đơn thử từ bàn in ra ở bếp |
| 8 | Chạy thử 1 ngày trước khi quảng bá | Cả hai | Không có lỗi trong tab **Logg** |

### Một hàm serverless duy nhất

Vercel gói Hobby chỉ cho tối đa 12 serverless function mỗi lần deploy. Vì vậy toàn bộ API đi qua **một** file duy nhất `api/index.js`. Mọi địa chỉ `/api/...` được `rewrites` trong `vercel.json` chuyển về file này (`/api/:route*` → `/api/index?route=:route*`), rồi file này chuyển tiếp sang các handler trong `lib/routes/`:

| Đường dẫn | Handler |
|---|---|
| `/api/submit` | `lib/routes/submit.js` – đặt món và đặt bàn |
| `/api/admin` | `lib/routes/admin.js` – màn hình bếp (cần `x-admin-key`) |
| `/api/availability` | `lib/routes/availability.js` – giá và món hết, cache 60 giây |
| `/api/health` | `lib/routes/health.js` – kiểm tra kết nối Google Sheet |
| `/api/print` | `lib/routes/print.js` – cầu nối Raspberry Pi (dự phòng) |
| `/api/sdp/<SDP_KEY>` | `lib/routes/sdp.js` – Epson Server Direct Print |
| `/api/cloudprnt/<KEY>` | `lib/routes/cloudprnt.js` – Star CloudPRNT (dự phòng) |
| `lib/hours.js` | `openNow()` – từ 2 h trước giờ mở cửa đến 1 h sau giờ đóng (giờ Thụy Điển; `BEFORE_MIN`/`AFTER_MIN`). Ngoài giờ: máy in (`/api/sdp`) chỉ hỏi hàng đợi Google Sheets 5 phút/lần, `/api/board` trả `closed` không gọi Sheets, `/skarm` hỏi 5 phút/lần, `/kok` 3 phút/lần (chủ trang 2026-10-28: giảm tải Vercel). Ngày đóng cả ngày (Chủ nhật, `closedDates`, `closedDay()`): máy in không hỏi Sheets lần nào (đơn in vào ngày mở cửa kế tiếp), `/skarm` và `/kok` 30 phút/lần |

Thêm đường dẫn mới: viết handler trong `lib/routes/` rồi khai báo trong bảng `ROUTES` (một tầng, ví dụ `/api/x`) hoặc `KEYED` (hai tầng, khoá nằm trong địa chỉ, ví dụ `/api/x/<khoá>`) của `api/index.js`. Số lượng endpoint không còn bị giới hạn.

Lịch sử: bản đầu dùng catch-all `api/[...route].js`. Trên Vercel nó chỉ bắt được địa chỉ một tầng (`/api/submit`) nhưng **không** bắt được hai tầng (`/api/sdp/<khoá>`), máy in nhận trang 404 của Vercel. Vì thế đổi sang `api/index.js` + `rewrites` tường minh. Đừng đổi lại.

Lưu ý: thư mục ảnh đặt tên `static/bilder/` chứ không phải `meny`, vì `/meny` đã là đường dẫn của trang menu; trùng tên sẽ làm trang menu không mở được.

## Biến môi trường Vercel

| Biến | Bắt buộc | Lấy ở đâu |
|---|---|---|
| `GAS_URL` | ✔ | Sheet → Hanami → Visa API-nyckel |
| `GAS_SECRET` | ✔ | như trên |
| `ADMIN_KEY` | ✔ | tự đặt (mật khẩu `/kok`) |
| `SDP_KEY` | ✔ | tự đặt, chữ + số, ≥ 32 ký tự |
| `SDP_ID` | nên có | `hanami-kok` |
| `REQUIRE_SHEET_MENU` | nên có | `1` |

Tạo khoá ngẫu nhiên trên Mac: `openssl rand -hex 24`

### Skriptegenskaper (Apps Script)

| Thuộc tính | Bắt buộc | Giá trị |
|---|---|---|
| `API_SECRET` | ✔ | `setup` tự tạo, không sửa |
| `NOTIFY_EMAIL` | ✔ | mail quán |
| `SITE_URL` | ✔ | `https://hanamisushibar.se` |
| `VERCEL_DEPLOY_HOOK` | ✔ | Vercel → Settings → Git → Deploy Hooks |
| `ELKS_USER`, `ELKS_PASSWORD`, `SMS_FROM` | tuỳ chọn | 46elks.se |

## Kiến trúc

| Tầng | Vai trò | Ai sửa |
|---|---|---|
| **Google Sheet** | Cơ sở dữ liệu: đơn hàng, đặt bàn, **menu**, nhật ký lỗi | Quán |
| **Apps Script** (`apps-script/`) | Kiểm tra món và giá theo Sheet, đánh số đơn, gửi mail/SMS, trigger | Bạn (qua GitHub) |
| **Vercel** (`api/`, `src/`) | Web, kiểm tra giờ mở cửa/định dạng, cổng API giữ kín khoá Apps Script, màn hình bếp, endpoint cho máy in | Bạn (qua GitHub) |
| **Epson TM-m30III** | Tự hỏi web mỗi 5 giây, có đơn là in (Server Direct Print) | Quán (chỉ cắm điện + LAN) |
| **GitHub** | Nguồn duy nhất của code; tự test, tự deploy Apps Script | Bạn |

Nguyên tắc:
- Trình duyệt **không bao giờ** thấy URL hay khoá Apps Script; mọi gọi đi qua `/api/*` trên Vercel.
- **Giá luôn lấy từ Sheet** lúc nhận đơn; giá gửi từ trình duyệt bị bỏ qua.
- Menu được render sẵn thành HTML lúc build (tốt cho Google). "Slut idag" và giá mới cập nhật lên web trong vòng 1 phút, không cần build lại.

Luồng thay đổi:

| Muốn đổi | Làm ở đâu | Lên web khi nào |
|---|---|---|
| Hết món hôm nay | `/kok` → Meny idag, hoặc tick cột *Slut idag* | ≤ 1 phút, tự reset 04:00 |
| Giá món | Sheet → Meny → cột *Pris* | Đơn mới tính giá mới ngay; giá hiển thị cập nhật ≤ 1 phút |
| Thêm/bớt món, đổi tên, mô tả | Sheet → Meny, rồi **Hanami → Publicera webbplatsen** | ~1 phút |
| Giờ mở cửa, ngày nghỉ lễ | `data/settings.js` → push GitHub | ~1 phút |
| Code Apps Script | `apps-script/` → push GitHub | GitHub Action tự deploy |

---

## Giao diện

Cùng bố cục, font và hiệu ứng như Vietfood (QDesign), nhưng bảng màu riêng cho Hanami: **trắng, hồng anh đào, xanh koi**, chữ **vàng gold**.

| Vai trò | Màu | Dùng cho |
|---|---|---|
| Nền | trắng ấm `#FCF9F8`, thẻ trắng `#FFFFFF` | trang, thẻ, form |
| Hồng | dải `#FBEEF2 → #F7E4EA`, hồng đậm `#E48FA8`, hồng nhạt `#F9E3E9` | dải xen kẽ, cành anh đào, viền thẻ, số thứ tự, vòng trăng ở hero |
| Xanh koi | `#1873BC`, xanh đậm `#0F3D6E` | logo, nút phụ, nút +, mục đang chọn, ô nhập khi focus, thanh giỏ hàng, chân trang, tiêu đề lớn ở hero |
| Vàng gold | `#B8923F` / đậm `#9A7732`, nhũ `#7A5E24 → #E5CF98` | mọi tiêu đề, nhãn nhỏ, giá, nút chính (nền vàng, chữ nâu sẫm) |
| Chữ | xanh xám đậm `#1B2A3A`, phụ `#4C5B6B` | nội dung |

Nguyên tắc phối: **vàng = chữ**, **xanh = thao tác** (nút, link, focus), **hồng = bề mặt và trang trí**, trắng làm nền để ba màu không chọi nhau. Chữ vàng dùng tông đậm để đọc được trên nền trắng (độ tương phản đạt WCAG AA); chữ nhũ quét sáng chỉ ở tiêu đề.

| Thành phần | Giá trị |
|---|---|
| Font | **Playfair Display** cho tiêu đề (dòng nhấn in nghiêng), **Jost** cho nội dung, nút, nhãn |
| Nhãn, nút | chữ hoa giãn 0,22em, bo góc 2 px; nút vàng có ánh sáng quét |
| Màn hình chào | Hai con koi (trắng và xanh) bơi vòng âm dương 3,5 giây rồi nhập thành logo, logo bay về chỗ trên trang. **Hiện lại mỗi lần tải trang**, cả trang chủ lẫn trang menu. Bỏ qua khi khách quét QR ở bàn (`?bord=`) và khi thiết bị bật giảm chuyển động. Muốn chỉ chạy ở trang chủ: trong `scripts/build.mjs` đổi `<!--SPLASH-->` thành `path === "/" ? read(...) : ""` |
| Phim món ăn | Nằm trong mục **Boka bord**, dưới phần giới thiệu bên trái form (máy tính) hoặc phía trên form (điện thoại, khung 4:3). Tự phát không tiếng, lặp lại, **chỉ phát khi cuộn tới** (IntersectionObserver) để tiết kiệm pin và dữ liệu; có nút bật tiếng. File `static/intro.mp4` 1,2 MB + ảnh bìa `intro-poster.jpg` |
| Ảnh món ăn | 11 ảnh của quán gắn vào 11 danh mục (`static/bilder/<id>-{s,m,l}.webp/jpg` cho banner 16:7 trên `/meny`, `<id>-sq` vuông cho 6 thẻ nổi bật trang chủ). Mỗi ảnh có ba cỡ, WebP kèm JPG dự phòng, tải lười (lazy) nên trang menu vẫn nhẹ. Thêm ảnh cho danh mục mới: đặt file đúng tên vào `static/bilder/`, build tự nhận, không cần sửa code |
| Hiệu ứng khác | tiêu đề bắn chữ từ phải, thẻ ánh gương hồng, cành anh đào đung đưa, cánh hoa rơi chậm |
| Nút nổi | **Boka & Beställ** (vàng) → hộp ba lựa chọn; trên trang chủ chỉ hiện sau khi cuộn qua hai nút chính |
| Logo | cá koi xanh trong vòng trăng hồng |

Hai trang:
- **`/`** – trang chủ: hero, ưu đãi (lunch/happy hour/student, tự hiện "Gäller nu"), 6 nhóm món nổi bật (giá "från" tính tự động từ menu), cách đặt tại bàn, giờ mở cửa (hôm nay tự sáng), bản đồ chỉ tải khi bấm, form đặt bàn.
- **`/meny`** – menu đầy đủ: tìm kiếm, thanh danh mục dính, giỏ hàng, thanh đặt hàng dưới đáy, chế độ bàn (`/meny?bord=5`). Link cũ `/?bord=5` tự chuyển sang đây.

**Ghi chú và xác nhận**
- Mỗi món trong giỏ có nút **"+ Önskemål för den här rätten"** để ghi yêu cầu riêng (tối đa 120 ký tự), ví dụ "utan avokado". Ghi chú này đi theo món qua Sheet → màn hình bếp → phiếu in, luôn nằm ngay dưới tên món.
- Ngoài ra vẫn có ô **Meddelande till köket** cho yêu cầu chung của cả đơn, chỗ ghi dị ứng.
- Khách điền **e-post** (không bắt buộc) thì nhận mail xác nhận: đơn hàng có đầy đủ món, ghi chú, tổng tiền, giờ lấy; đặt bàn thì nhận bản sao yêu cầu kèm lưu ý bàn chỉ chắc chắn khi quán xác nhận. Cột **Bekräftelse** trong Sheet ghi giờ đã gửi.
- Mail gửi qua tài khoản Google của quán. Gmail thường giới hạn 100 mail/ngày, tính cả mail báo cho quán lẫn mail cho khách, tức khoảng 50 đơn mỗi ngày. Vượt mức thì dùng Google Workspace (1 500/ngày).

Mọi hiệu ứng tắt khi thiết bị bật *giảm chuyển động*. Nội dung vẫn hiện đủ nếu JavaScript lỗi.

Tệp giao diện:

```
src/theme.css          hệ thiết kế dùng chung (màu, chữ, nút, thẻ, form, footer, dialog)
src/common.js          giờ mở cửa, hiệu ứng, nút Boka & Beställ, gửi dữ liệu
src/partials/          header, footer, nút nổi + hộp chọn, màn hình chào (koi), SVG (cành anh đào, icon)
src/index.html         trang chủ (+ CSS và JS riêng)
src/meny.html          trang menu và giỏ hàng (+ CSS và JS riêng)
src/kok.html           màn hình bếp (giao diện sáng, dễ đọc trong bếp)
```

Lúc build, CSS và JS được nhúng thẳng vào từng trang HTML (giống Vietfood: không có file CSS/JS rời để tránh lỗi mất style). Font tải từ Google Fonts.

## 0. Chuẩn bị (tránh lỗi "Det går inte att öppna filen")

Lỗi bạn gặp trước đó do Chrome đăng nhập **nhiều tài khoản Google**. Tạo một **Chrome profile riêng** chỉ đăng nhập tài khoản sẽ sở hữu Sheet (nên là tài khoản của quán hoặc Google Workspace của Queenie89 AB), và làm mọi bước Google trong profile đó.

Bật Apps Script API cho tài khoản này: https://script.google.com/home/usersettings → **Google Apps Script API: På**.

## 1. GitHub

```bash
cd hanami-pro
npm test                       # 14 tester OK
git init && git add . && git commit -m "Hanami: webb + Apps Script"
git branch -M main
git remote add origin https://github.com/<tai-khoan>/hanami-sushibar.git
git push -u origin main
```

## 2. Google Sheet + Apps Script

1. Tạo Google Sheet mới, đặt tên `Hanami – Drift`.
2. **Tillägg → Apps Script**. Đặt tên project `Hanami backend`.
   ⚙️ **Projektinställningar** → copy **Skript-ID**.
3. Đẩy code lên bằng clasp (trên máy bạn):

```bash
npx @google/clasp@2.4.2 login            # mở trình duyệt, chọn đúng tài khoản
cp apps-script/.clasp.json.example apps-script/.clasp.json
# sửa scriptId trong apps-script/.clasp.json
npm run gas:push
```

   > Không muốn dùng clasp: trong Apps Script tạo từng file tên giống thư mục `apps-script/` (Config, Api, Sheets, Orders, Menu, Notify, Setup, MenuSeed), dán nội dung vào. Bật *Visa manifestfilen* trong Projektinställningar và dán `appsscript.json`.

4. Tải lại Apps Script, chọn hàm **setup** → **Kör** → cấp quyền (Avancerat → Gå till Hanami backend → Tillåt).
   Sheet sẽ có 4 tab, menu mẫu 101 món, dropdown trạng thái, màu, trigger, và menu **Hanami** trên thanh công cụ.
5. ⚙️ **Projektinställningar → Skriptegenskaper**, thêm:

| Thuộc tính | Giá trị |
|---|---|
| `NOTIFY_EMAIL` | mail quán nhận đơn (nhiều mail cách nhau dấu phẩy) |
| `SITE_URL` | `https://hanamisushibar.se` |
| `ELKS_USER`, `ELKS_PASSWORD` | từ 46elks.se (bỏ trống = không gửi SMS) |
| `SMS_FROM` | `Hanami` |
| `VERCEL_DEPLOY_HOOK` | điền ở bước 3 |

   `API_SECRET` đã được `setup` tự tạo, **không sửa**.

6. **Distribuera → Ny distribution** → ⚙️ **Webbapp**
   - Beskrivning: `prod`
   - Kör som: **Jag**
   - Vem har åtkomst: **Alla**
   → **Distribuera**. Copy **Distributions-ID** và **Webbapp-URL**.

7. Trong Sheet: **Hanami → Visa API-nyckel för Vercel** → copy `GAS_URL` và `GAS_SECRET`.

## 3. Vercel

1. **Add New → Project** → chọn repo → Framework: *Other* → chưa Deploy vội, mở **Environment Variables**:

| Biến | Giá trị |
|---|---|
| `GAS_URL` | Webbapp-URL (kết thúc bằng `/exec`) |
| `GAS_SECRET` | từ bước 2.7 |
| `ADMIN_KEY` | mật khẩu màn hình bếp, dài và khó đoán |
| `REQUIRE_SHEET_MENU` | `1` (build thất bại thay vì dùng menu dự phòng) |
| `SDP_KEY` | khoá cho máy in, chữ + số ≥ 32 ký tự (`openssl rand -hex 24`) |
| `SDP_ID` | `hanami-kok` |

2. **Deploy**. Log build phải có dòng `Byggt från Google Sheet`.
   Lần deploy đầu tiên có thể dùng menu dự phòng nếu chưa điền biến; để `REQUIRE_SHEET_MENU` trống lần đầu, đặt `1` sau khi `/api/health` ok.
3. Mở `https://<project>.vercel.app/api/health` → `"ok": true` và thời gian `ms` (Apps Script thường 800–2500 ms).
4. **Settings → Git → Deploy Hooks** → tên `sheet-menu`, branch `main` → copy URL → dán vào Skriptegenskap `VERCEL_DEPLOY_HOOK`.
5. Thử: Sheet → **Hanami → Skicka testbeställning** → mail đến, đơn hiện trong `/kok`.

## 4. GitHub Actions tự deploy Apps Script

GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Lấy ở đâu |
|---|---|
| `CLASPRC_JSON` | toàn bộ nội dung `~/.clasprc.json` sau khi `clasp login` |
| `GAS_SCRIPT_ID` | Skript-ID (bước 2.2) |
| `GAS_DEPLOYMENT_ID` | Distributions-ID (bước 2.6) |

Từ giờ mỗi lần push thay đổi trong `apps-script/`:
`Check` chạy test + build → `Apps Script` chạy test → `clasp push` → cập nhật **đúng deployment cũ**, nên `GAS_URL` không bao giờ đổi.

Vercel tự deploy mỗi lần push `main`; mỗi pull request có bản Preview riêng.

> Token trong `CLASPRC_JSON` thuộc tài khoản Google của bạn. Nếu đổi mật khẩu hoặc thu hồi quyền, chạy lại `clasp login` và cập nhật secret.

## 5. Máy in Epson TM-m30III

Máy in **Epson TM-m30III** (khối vuông, giấy 80 mm, cổng LAN + USB, có NFC) tự gọi lên web mỗi 5 giây, có đơn mới thì in, in xong báo lại. Không cần iPad, không cần máy tính trong bếp.

```
Beställning (web) → Vercel → Apps Script → Sheet (cột "Utskriven" trống)
                                                   ▲
 TM-m30III ──POST GetRequest "có gì in không?"──▶ /api/sdp/<SDP_KEY> ──▶ hỏi Apps Script
           ◀── ePOS-Print XML: kvitto (tối đa 3 đơn/lần) ──┘
           ──POST SetResponse success="true"──▶ Sheet: "Utskriven" = giờ in
```

Máy in mất điện hay hết giấy: đơn nằm chờ, in khi máy sẵn sàng (lỗi thì đơn không bị đánh dấu). Nút **🖨** trên mỗi thẻ đơn trong `/kok` để in lại.

### 5.1 Máy và phụ kiện

| Hạng mục | Ghi chú |
|---|---|
| Máy in | **Epson TM-m30III** (đã mua). Số serial dưới đáy máy = mật khẩu mặc định của trang cấu hình |
| Mạng | **Dây LAN** từ router quán vào cổng LAN sau máy. Máy này **không có Wi-Fi sẵn**; muốn Wi-Fi phải mua thêm dongle Epson **OT-WL06** cắm cổng USB. Dây LAN ổn định hơn, nên dùng |
| Giấy | Giấy nhiệt **80 mm**, đường kính cuộn ≤ 80 mm, loại không phenol |
| Tuỳ chọn | Còi **OT-BZ20** nếu bếp ồn |

Đặt máy xa bếp nóng và hơi nước: giấy nhiệt bị đen khi quá nóng.

### 5.2 Cấu hình máy in (khoảng 15 phút, làm một lần)

**Trên Vercel (trước):** Settings → Environment Variables phải có `SDP_KEY` (chữ thường + số, ≥ 16 ký tự ngẫu nhiên, ví dụ `openssl rand -hex 12`) và `SDP_ID` = `hanami-kok`, cả hai ở **Production**. Đổi biến xong phải **Redeploy** bản Production.

**Trên máy in:**

1. Lắp giấy, cắm dây LAN vào **cổng LAN của router** (không phải cổng WAN/Internet), bật máy. Sau khoảng 1 phút máy tự in một phiếu có **IP Address** và dòng `DHCP: Enable`. Nếu in ra `192.168.192.168` và `DHCP: No Server` là dây chưa cắm đúng.
2. Vào router của quán, **đặt IP cố định** (DHCP reservation) cho máy in theo địa chỉ MAC trên phiếu.
3. Trên máy tính cùng mạng, mở `https://<IP máy in>` (trình duyệt cảnh báo chứng chỉ tự ký, chọn *Tiếp tục*). Bấm **Advanced Settings** → **Administrator Login**, mật khẩu = số serial (hoặc dòng *Initial Password* trên Network Status Sheet).
4. Tab **Status** → menu trái **TM-Intelligent** → mở **TM-i Settings** (tab mới) → **Services → Server Direct Print**:

| Trường | Giá trị |
|---|---|
| Server Direct Print | **Enable** |
| Server1 → URL | `https://hanamisushibar.se/api/sdp/<SDP_KEY>` (khi chưa trỏ tên miền: `https://hanamisushibar.vercel.app/api/sdp/<SDP_KEY>`) |
| Server1 → Interval | **5** |
| Server2, Server3 | để trống |
| ID | `hanami-kok` (phải đúng bằng `SDP_ID`) |
| Password | để trống (không dùng) |
| URL Encode / Server Authentication | giữ mặc định |

   Bấm **Apply & Restart**.
5. Trang cấu hình chính → **Device Management → Date and Time → Time Server**: Enable, server `pool.ntp.org`. Máy in cần giờ đúng để xác minh chứng chỉ HTTPS.
6. Kiểm tra từ máy tính: mở `https://hanamisushibar.vercel.app/api/sdp/<SDP_KEY>` trong trình duyệt → phải thấy `"ok": true` và `jobsWaiting`. Thấy `Not found` là key trên Vercel khác key trong URL; thấy trang 404 của Vercel là code `api/index.js` + `rewrites` chưa deploy.
7. Kiểm tra từ máy in: nút nhỏ phía sau máy → menu in ra → bấm **Feed nhanh 3 lần**, giữ Feed 1 giây → **TM-i Status Sheet**. Mục *Server Direct Print → Access Test* phải là `HTTP Status Code : 200`.
8. Đặt một đơn thử trên web (hoặc Sheet → **Hanami → Skicka testbeställning**). Trong 5–10 giây kvitto in ra, cột **Utskriven** có giờ. Kiểm tra chữ **åäö** và cắt giấy.

Không in? Xem mục 8. Thường gặp nhất: 404 (sai key hoặc chưa Redeploy), 403 (ID khác `SDP_ID`), giờ máy in sai (lỗi chứng chỉ), router chặn HTTPS ra ngoài.

**Phím trên máy:** nút trên nắp (biểu tượng giấy) là **Feed**; nút nhỏ phía sau cạnh cổng mạng in Network Status Sheet (bấm nhanh) hoặc **reset mạng** (giữ ≥ 10 giây, tránh nhầm).

### 5.3 Kvitto

Định dạng **ePOS-Print XML**, 32 ký tự mỗi dòng cho TM-m30III giấy **58 mm** (giấy 80 mm: 48) (`data/settings.js` → `receiptWidth`, có thể ghi đè tạm bằng biến môi trường `RECEIPT_WIDTH`), bố cục trong `lib/receipt-epos.js`. Ví dụ dưới minh hoạ bố cục (vẽ ở 42 cột):

```
              HANAMI SUSHI BAR             ← đậm, cao gấp đôi
                 16/9 18:12
==========================================
H1023                                      ← chữ lớn gấp đôi
HÄMTNING
IMORGON KL 18:30
==========================================
 1  Sushi mix 30                       409 ← đậm, cao gấp đôi
 2  Bubble tea mango                   138
------------------------------------------
KOMMENTAR:
Utan vårlök, extra chilimajonnäs           ← cao gấp đôi
------------------------------------------
Summa                               547 kr
Betalning: Swish
Anna Svensson  070-123 45 67
------------------------------------------
     hanamisushibar.se  ·  0431-472999
```

Tuỳ chọn:
- **Còi OT-BZ20**: thêm `<sound pattern="pattern_a" repeat="2"/>` trước `<cut>` trong `receipt-epos.js`.
- **Logo**: nạp logo vào máy bằng Epson TM Utility (key 32/32), thêm `<logo key1="32" key2="32" align="center"/>` đầu kvitto.
- **2 bản** (bếp + kẹp túi khách): lặp nội dung `eposReceipt` hai lần trong `sdpDocument`.

Tải: 5 giây/lần ≈ 17 000 lần gọi Apps Script mỗi ngày nếu máy bật 24/7, nằm trong giới hạn của Google nhưng nên **tắt máy in khi đóng cửa** hoặc đặt interval 10 giây.

## 6. Tên miền

Vercel → **Settings → Domains** → thêm `hanamisushibar.se` và `www.hanamisushibar.se`. Tại nhà cung cấp tên miền:

- `A` `@` → `76.76.21.21`
- `CNAME` `www` → `cname.vercel-dns.com`

Đổi DNS là trang cũ ngừng hiện ngay, nên hẹn giờ với quán. Giữ nguyên bản ghi MX nếu quán có mail trên tên miền.

## 7. Quán dùng hằng ngày

**iPad trong bếp**: `https://hanamisushibar.se/kok` → Safari → Chia sẻ → *Lägg till på hemskärmen*. Mở xong bấm **Ljud på** một lần.

- **Máy in** tự in mọi đơn mới (cả hämtning lẫn tại bàn). Thẻ đơn ghi `🖨 18:12` khi đã in, `🖨 väntar` khi chưa.
- **Beställningar**: đơn hôm nay, tự làm mới 20 giây, kêu bíp khi có đơn mới. Börja tillaga → Klar (khách hämtning nhận SMS) → Hämtad/Serverad.
- **Bokningar**: Bekräfta / Avböj, khách nhận SMS.
- **Meny idag**: gạt công tắc để báo hết món.
- **QR‑koder**: in QR cho từng bàn, trỏ tới `/meny?bord=N` (làm sau khi tên miền đã trỏ đúng).
- **Google Sheet**: mở thẳng bảng tính. Đổi cột *Status* trong Sheet cũng gửi SMS như trong bếp.

### 7.1 Sushi mix: chọn maki, đổi nigiri

Sushi mix 8, 10, 12, 15, 20 và Mamma mix mở hộp chọn khi khách bấm +:
- Mỗi phần "5 maki (kockens val)" đổi được sang 5 miếng California, Chili, Philadelphia, Alaskan, Green hoặc Vegan maki – miễn phí. Sushi mix 20 có 2 cuộn, chọn riêng từng cuộn.
- Nigiri đổi tự do. 4 miếng đổi đầu tiên miễn phí, từ miếng thứ 5 cộng 10 kr/miếng.
- Lựa chọn in lên phiếu bếp, hiện trong köksvy và e-mail, ví dụ `Maki: 5 Philadelphia maki · Nigiri: 5 tonfisk, 2 avokado`.

Nigiri (nigiri-1) và Special nigiri (nigiri-2): khách bấm + từng sort muốn lấy, giá theo cột Pris trong Sheet × số miếng (19 kr và 23 kr). Nigiri: lax, tonfisk, avokado, krabbstick, jätteräka, tofu, wakame, krabbröra. Special: flamberad lax, flamberad jätteräka.

Bubble tea (bubble-1, bubble-2, bubble-3): khách chọn 1 popping boba (mango, jordgubb, blåbär, lychee) – ingår. Extra boba từng vị và extra tapioka +10 kr mỗi thứ. Khách chưa chọn boba thì không thêm được vào giỏ.

Thành phần từng mix, danh sách nigiri/maki được đổi và mức phí nằm trong `lib/mix.js`. **Nếu quán sửa mô tả một mix trong Google Sheet, phải sửa `lib/mix.js` theo.** Happy hour không cho đổi.

Phí đổi được Vercel tính (`lib/mix.js`) rồi Apps Script cộng vào giá trong fliken Meny, nên sau khi cập nhật code phải đẩy cả Apps Script (`npm run gas:deploy` hoặc GitHub Actions).

### 7.2 Giờ lấy đơn: chủ quán chọn "klar om …"

Khách **không tự chọn giờ lấy** nữa. Giờ lấy = **bây giờ (hoặc giờ mở cửa, nếu đặt trước khi mở) + thời gian chủ quán chọn**, làm tròn lên 5 phút.

- Màn hình bếp `/kok`, tab Beställningar có hàng nút **Hämtning klar om**: 15 · 20 · 30 · 45 min · 1 h · 1 h 15 · 1 h 30 · 2 h. Bấm là lưu ngay. Quán đông thì bấm 45 hoặc 1 h, vắng thì về 30.
- Giá trị lưu trong Skriptegenskaper `PICKUP_LEAD` của Apps Script. Apps Script tính giờ lấy cuối cùng khi nhận đơn, nên đơn luôn dùng giá trị mới nhất. Trang khách hiện giờ dự kiến; giá trị trên trang cập nhật chậm nhất khoảng 3 phút.
- Chưa bấm gì thì dùng mặc định `pickupLeadMinutes` trong `data/settings.js` (30 phút).
- Khách muốn lấy muộn hơn ghi vào ô **"Vill du hämta senare?"**. Nội dung vào phần ghi chú, in dưới **KOMMENTAR** dạng `Önskar hämta: kl 18.30`.
- **Đặt đơn 24/7:** ngày đóng cửa, sau giờ đóng cửa, hoặc khi bếp không kịp trước giờ đóng → đơn tự chuyển sang **ngày mở cửa kế tiếp**, giờ lấy = giờ mở cửa + thời gian chủ quán chọn (VD 11:00 + 30 phút = 11:30). Bỏ qua Chủ nhật và các ngày trong `closedDates`. Quy tắc nằm ở `lib/pickup.js` (Vercel), `pickupInfo()` trong `src/meny.html` (trang khách) và `createOrder_` trong `apps-script/Orders.js`.
- Đơn đặt ban đêm: máy in in ngay nếu đang bật (đầu đơn ghi `IMORGON` / `KL 11:30`), nếu tắt thì in khi bật máy sáng hôm sau (lúc đó ghi `IDAG`). Trong `/kok` đơn nằm ở **ngày lấy hàng**.
- "Slut idag" chỉ áp dụng cho đơn lấy trong ngày; đơn cho ngày mai vẫn đặt được món đó.
- **Happy hour (từ 2026-10-13):** *mang về* — khách **đặt bất cứ lúc nào, mọi ngày**, nhưng **cả đơn chỉ lấy 16.00–17.00** một ngày quán mở. **Đặt NGOÀI 16–17** → khách tự chọn ngày + giờ 16.00–17.00. **Đặt TRONG 16–17** → hôm nay lấy theo **thời gian chuẩn bị chủ quán chọn trong köksvyn** (15/20/30/45 phút, giống mọi đơn trong ngày), không chọn giờ; khách vẫn có thể chọn ngày khác. Món happy hour có chữ **HH** sau tên (phiếu in, köksvyn, e-mail, Stripe) — cần đưa `apps-script/Orders.js` lên Apps Script. Ở bước thanh toán khách chọn **Dag** (hôm nay + tối đa `pickupDaysAhead` = 3 ngày, bỏ ngày đóng cửa) và **Tid** (16.00 / 16.15 / 16.30 / 16.45 / 17.00 — cả khung giờ, hôm nay chỉ ẩn mốc đã qua; không áp thời gian chuẩn bị của bếp). Món lunch + happy hour cùng một đơn bị chặn (giờ lấy khác nhau) với thông báo rõ. *Tại bàn (QR)* — như cũ, chỉ đặt được trong 16–17. Quy tắc: `lib/happy.js` (server) và `happySlots()` trong `src/meny.html` (web); test `tests/happy.test.mjs`.
  Bếp: đơn đặt trước cho ngày sau vẫn **in ngay** khi khách đặt (phiếu ghi rõ ngày/giờ lấy, ví dụ "IMORGON KL 16:30"); trong köksvyn đơn nằm ở **ngày lấy** (chọn ngày đó trong ô ngày).
- Món lunch chỉ khi ngày lấy là thứ 2–6, 11–14.

### 7.3 Betald: đánh dấu đơn đã trả tiền

Mỗi thẻ đơn trong köksvy có nút **Markera betald**. Bấm là ghi giờ vào cột `Betald` trong fliken Beställningar, thẻ hiện nhãn xanh "Betald".

- Phiếu in: đơn đã trả in dòng **BETALD · SWISH** cỡ gấp đôi, in đậm. Đơn chưa trả in **EJ BETALD · SWISH** cỡ thường, in đậm, để chủ quán thấy ngay phải thu tiền.
- Phiếu in ra lúc nhận đơn luôn là "Ej betald", vì lúc đó tiền chưa vào. Sau khi bấm Betald, bấm nút 🖨 trên thẻ để in lại phiếu cho chủ quán.
- Hệ thống **không tự biết** khách đã Swish hay chưa. Nhân viên xem app Swish rồi bấm tay. Muốn tự động thì phải làm Swish Handel.
- Cột `Betald` là cột mới, nên sau khi đẩy code phải **chạy `setup()` một lần** trong Apps Script để thêm cột vào Sheet.

### 7.4 Dricks (tiền tip)

Ở bước thanh toán, khách chọn 5, 10, 15, 20 % hoặc tự nhập số tiền (tối đa 2000 kr). Nút gửi đơn hiện tổng đã cộng tip.

- Tip được tính lại trên server theo giá trong fliken Meny, không tin số từ trình duyệt.
- Lưu ở cột `Dricks` (cột mới) trong fliken Beställningar. Cột `Summa` là tổng đã gồm tip.
- Phiếu in có dòng `Dricks` ngay trên dòng `Summa`. Mail cho khách và mail cho quán cũng hiện tip.
- Cột `Dricks` là cột mới, nên sau khi đẩy code phải **chạy `setup()` một lần** trong Apps Script.

### 7.5 Sửa menu trong Sheet bằng code (không cần sửa tay)

File `data/menu-andringar.js` chứa danh sách thay đổi menu: đổi tên, giá, mô tả (`set`), thêm món mới ngay sau một món có sẵn (`add`), ẩn món (`hide`), và sửa Kategoritext (`notes`).

- Mỗi lần push, Vercel build bản production sẽ gọi Apps Script (`applyMenuPatches`) để đưa các thay đổi **chưa chạy** vào fliken Meny, rồi mới đọc menu để build trang. Nghĩa là **push xong là Sheet và web cùng cập nhật**.
- Mỗi thay đổi có một `id` và chỉ chạy **một lần**. Danh sách id đã chạy lưu trong Skriptegenskaper `MENU_PATCHES_DONE`. Muốn đổi tiếp thì thêm mục mới với id mới ở cuối file, đừng sửa mục cũ.
- Chỉ những ô được ghi trong thay đổi mới bị đụng tới. Giá hoặc chữ quán tự sửa trong Sheet ở chỗ khác được giữ nguyên.
- Không bao giờ xoá hàng. Món bỏ đi thì chỉ bỏ tick "Visas på webben".
- Kết quả ghi trong fliken Logg (dòng "Menyändringar") và trong build log trên Vercel.
- Cần Apps Script bản mới (có `applyMenuPatches`). Nếu Apps Script cũ, build vẫn chạy bình thường, chỉ báo cảnh báo và bỏ qua bước này.

### 7.6 Tắt / mở đặt món online (một chạm)

Khi quán không muốn nhận đơn qua web (chờ Swish Handel, quá đông, máy in hỏng…):

- **Màn hình bếp `/kok`**, ngay dưới thanh công cụ: ô **Onlinebeställning PÅ/AV** với nút **Stäng beställning / Öppna beställning**. Tắt có hộp xác nhận; mở lại không hỏi.
- Hoặc trong Sheet: menu **Hanami → Onlinebeställning PÅ / AV**.
- Trạng thái lưu trong Skriptegenskaper `ORDERING_OPEN` (`on`/`off`), lời nhắn tuỳ chọn trong `ORDERING_MESSAGE` (mặc định: "Onlinebeställning är tillfälligt stängd. Ring oss på 0431-472999 så hjälper vi dig.").
- **Khi tắt:** trang menu vẫn xem được nhưng hiện băng thông báo đỏ nhạt với nút gọi điện, nút **+** bị khoá, giỏ hàng cũ vẫn còn nhưng không gửi được. Server (Apps Script) từ chối mọi đơn với mã 423, nên không lách được. Đơn tại bàn (QR) cũng bị chặn. **Đặt bàn vẫn hoạt động bình thường.**
- Trang khách cập nhật trong tối đa 3 phút (cache 60 s + hỏi lại mỗi 2 phút); server chặn ngay lập tức.
- `/api/health` hiện `ordering: open | closed`. Testbeställning từ menu Sheet vẫn chạy khi đang tắt (dùng để thử máy in).

### 7.7 Dọn dẹp tự động: Sheet luôn nhẹ (`apps-script/Cleanup.js`)

Mỗi đêm **04:30** Apps Script tự dọn tab Beställningar, Bokningar và Logg để web, màn hình bếp và máy in luôn nhanh:

| Việc | Quy tắc | Ghi chú |
|---|---|---|
| **Lưu trữ** | Đơn và đặt bàn có ngày cũ hơn **30 ngày** → chuyển sang file Sheet riêng **"Hanamisushibar – Arkiv"**, rồi xoá khỏi Sheet chính | Luật kế toán Thuỵ Điển (Bokföringslagen) yêu cầu giữ chứng từ 7 năm, nên không xoá mà **chuyển**. Chuyển xong mới xoá; chuyển lỗi thì không đụng gì |
| **Xoá hẳn** | Đơn/đặt bàn **Avbokad** cũ hơn 7 ngày; dòng **Logg** cũ hơn 14 ngày | Không có doanh thu, không cần lưu |
| **Ẩn danh** | Trong file lưu trữ, dòng cũ hơn **12 tháng** bị xoá tên, điện thoại, e-mail, ghi chú (kể cả ghi chú dị ứng trong món) | GDPR, đúng thoả thuận 12 tháng với quán. Giữ lại số tiền, món, ngày, loại đơn cho kế toán |

- "Ngày" của một dòng là ngày **muộn nhất** giữa *Mottagen* và *Hämtas datum/Datum*. Đặt bàn cho tháng sau không bao giờ bị dọn.
- Không bao giờ đụng tab **Meny**. Chạy dưới LockService nên đơn vào cùng lúc không bị mất.
- Tối đa 1 500 dòng mỗi đêm, dừng sau 4 phút; phần còn lại dọn đêm sau.
- Mặc định là **provkörning** (chỉ đếm, không đổi gì) cho tới khi bật.

**Bật lần đầu (menu Hanami → Städning trong Sheet):**
1. **Provkör** → xem số liệu: bao nhiêu đơn sẽ lưu trữ, bao nhiêu bị xoá.
2. Thấy hợp lý → **Slå på nattlig städning**. Từ đó mỗi sáng tab Logg có một dòng "Städning: Arkiverat …".
3. Muốn dọn ngay (lần đầu Sheet đang đầy) → **Städa nu**.
4. **Öppna arkivarket** cho link file lưu trữ. Quán có thể chia sẻ file này cho kế toán.

Thay đổi quy tắc: sửa số ngày trong `CLEAN` đầu file `Cleanup.js`. `/api/health` hiện số dòng từng tab (`rows`) và trạng thái dọn dẹp (`cleanup: on | dry-run`).

**`setup()` nhanh:** chỉ làm phần bắt buộc (tiêu đề cột, trigger, khoá), vài giây, và ghi thời gian từng bước vào Logg/nhật ký thực thi. Định dạng (kiểu chữ, màu trạng thái, checkbox) chỉ làm cho tab mới tạo. Thêm món mới vào tab Meny thì chọn **Formatera menyfliken**; cần làm lại toàn bộ định dạng thì **Lägg om all formatering (långsamt)**, giới hạn ở số dòng đang có + 500 nên không còn quét cả bảng trống.

## 8. Khi có sự cố

| Dấu hiệu | Kiểm tra |
|---|---|
| `/api/health` báo `Apps Script gav inget JSON` | Webbapp chưa để *Åtkomst: Alla*, hoặc cần cấp quyền lại: chạy `setup` một lần trong Apps Script |
| `401` / `Obehörig` | `GAS_SECRET` trên Vercel khác `API_SECRET` trong Skriptegenskaper |
| Build dùng "reservmeny" | Sheet không truy cập được lúc build; xem log Vercel |
| Không có mail | `NOTIFY_EMAIL`; hạn mức Gmail thường 100 mail/ngày (Workspace 1 500) |
| Không có SMS | Tab **Logg** trong Sheet ghi lỗi 46elks; kiểm tra số dư |
| Mọi lỗi khác | Tab **Logg**; Vercel → Logs (lọc `[hanami]`); Apps Script → Körningar |
| Máy in không in | Mở `https://…/api/sdp/<SDP_KEY>` trong trình duyệt: `"ok": true` → web ổn, lỗi ở máy in (in TM-i Status Sheet xem Access Test); `Not found` → key sai/chưa Redeploy; trang 404 Vercel → thiếu `rewrites`. Máy in: đèn lỗi, giấy, `ID` = `SDP_ID`, giờ máy in (Time Server), router cho phép HTTPS. Vercel → Logs lọc `[sdp]` |
| In 2 lần cùng một đơn | Mạng chập chờn làm máy in không gửi được SetResponse; đơn đã in vẫn đúng, chỉ cần bỏ bản thừa |
| Chữ åäö sai | Đổi `lang` trong thẻ `<text lang=…>` ở `receipt-epos.js` (xem ePOS-Print XML manual) |
| Web/köksvy chậm dần | `/api/health` → `rows.orders` lớn (vài nghìn)? Bật dọn dẹp (7.7) hoặc **Städa nu**. Mail "städningen misslyckades" → xem tab Logg, dòng ERROR Städning |
| Dọn dẹp báo lỗi quyền | Lần đầu `SpreadsheetApp.create` cần cấp quyền: chạy **Provkör** từ menu rồi chấp nhận hộp thoại quyền |

## 9. Trước khi bàn giao

- **Chủ sở hữu dữ liệu**: Sheet và Apps Script nên nằm trong tài khoản của quán (hoặc Workspace của bạn với quyền chia sẻ rõ ràng). Webbapp chạy dưới quyền người deploy.
- **GDPR**: Sheet chứa tên và số điện thoại khách. Dọn dẹp tự động (7.7) ẩn danh dữ liệu cũ hơn 12 tháng; ghi điều này trong chính sách bảo mật trên web.
- **Vercel Hobby** chỉ cho mục đích phi thương mại; web nhà hàng nên chạy trên **Pro**.
- Apps Script mất khoảng 1–3 giây mỗi yêu cầu; đủ cho một quán, và lock bảo đảm hai đơn cùng lúc không bị trùng số.
- Không có thanh toán online; khách trả Swish/thẻ tại quán.
- Menu mẫu lấy từ trang cũ; nhờ quán xác nhận Happy hour mix ghi "tofu" còn mix thường ghi "tonfisk".

---

## Phụ lục A – Đổi sang Star CloudPRNT

Dùng khi quán đổi sang máy Star có CloudPRNT (mC-Print3, hoặc SP742 **có card IFBD-HI02X**). Endpoint đã có sẵn.

`CLOUDPRNT_KEY` (+ tuỳ chọn `CLOUDPRNT_MAC`), web UI máy in → CloudPRNT → URL `https://hanamisushibar.se/api/cloudprnt/<CLOUDPRNT_KEY>`, interval 5 s. Kvitto ở `lib/receipt-star.js`, bề rộng 48.

Với SP742 (42 ký tự/dòng) đổi `WIDTH` trong `lib/receipt-star.js` thành 42.

## Phụ lục B – Cầu in cho máy in thường (không có in từ web)

Dùng cho máy như Epson TM-T20III: một máy nhỏ trong bếp (Raspberry Pi) chạy `print-bridge/`, hỏi web và gửi lệnh in qua USB/LAN. Khoá: `PRINT_KEY`.

Epson TM-T20III có hai bản, giá gần nhau (~1 800 kr):

| Bản | Kết nối | Nên chọn khi |
|---|---|---|
| **011** (C31CH51011) | USB + Serial | Có sẵn máy tính đặt cạnh máy in |
| **012** (C31CH51012) | Ethernet (cáp mạng) | Máy in đặt bất kỳ đâu có mạng; linh hoạt hơn về sau (ePOS) |

Cả hai đều chạy được với thiết kế dưới. Nếu quán chưa mua, **khuyên lấy 012**: máy in cắm vào router, không phụ thuộc cổng USB, và "cầu in" có thể chạy trên bất kỳ máy nào trong mạng.

Mua kèm: giấy nhiệt 80 mm, và với bản 011 kiểm tra hộp có cáp USB (Epson thường không kèm).

```
Beställning (web) → Vercel → Apps Script → Sheet (cột "Utskriven" trống)
                                                   ▲
                                                   │ GET /api/print (x-print-key), mỗi 5 s
                                            Cầu in (print-bridge/) trên máy trong bếp
                                                   │ ESC/POS
                                                   ▼
                                            Epson TM-T20III → kvitto
                                                   │
                                            POST /api/print { no } → "Utskriven" = giờ
```

Cầu in (`print-bridge/`) là một script Node không cần thư viện ngoài. Nó hỏi web mỗi 5 giây có đơn mới chưa in, in xong mới báo lại; nếu máy in mất điện, đơn vẫn nằm trong hàng đợi và được in khi máy in trở lại. Bếp có nút **🖨** trên mỗi thẻ đơn trong `/kok` để in lại.

#### Máy chạy cầu in
- **Raspberry Pi 4 (2 GB) hoặc Pi Zero 2 W** (~500–900 kr): nhỏ, im lặng, chạy 24/7, cắm USB thẳng vào máy in. Khuyên dùng.
- Hoặc **máy tính kassa** của quán nếu luôn bật (Windows/macOS): chạy cùng script.
- iPad **không** chạy được cầu in; iPad chỉ dùng cho `/kok`.

#### Cài đặt trên Raspberry Pi (bản 011, USB)

```bash
# Raspberry Pi OS Lite, cài Node 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs git
git clone https://github.com/<tai-khoan>/hanami-sushibar.git ~/hanami-sushibar
cd ~/hanami-sushibar/print-bridge
cp config.example.json config.json && nano config.json     # apiUrl, printKey, printer
sudo cp 99-epson.rules /etc/udev/rules.d/ && sudo udevadm control --reload && sudo udevadm trigger
node index.mjs --test                                      # phải in ra một testkvitto
sudo cp hanami-print.service /etc/systemd/system/ && sudo systemctl enable --now hanami-print
journalctl -u hanami-print -f                              # xem log
```

`printer` trong `config.json`:
- bản 011 trên Pi/Linux: `usb:/dev/usb/lp0`
- bản 012: `tcp:<IP máy in>:9100` (in trang status bằng nút Feed khi bật máy để thấy IP; đặt IP tĩnh trong router)
- macOS/Linux qua CUPS: `cups:<tên hàng đợi>` (thêm máy in dạng *Raw*)
- Windows: chia sẻ máy in với tên `EpsonTM` → `file:\\\\localhost\\EpsonTM`

`PRINT_KEY`: đặt một chuỗi bí mật trong Vercel → Environment Variables, và điền cùng giá trị vào `config.json`. Khoá này chỉ có quyền đọc hàng đợi in và đánh dấu đã in, không truy cập được gì khác.

#### Tuỳ chọn thêm
- **Còi báo**: Epson OT-BZ20 (cắm vào cổng drawer của máy in) kêu khi có đơn; thêm lệnh xung `ESC p` trong `receipt.mjs`. iPad ở `/kok` đã kêu bíp sẵn.
- **Logo trên kvitto**: nạp logo vào bộ nhớ máy in bằng Epson TM-T20III Utility, rồi thêm lệnh `FS p 1 0` đầu kvitto.

---

## Thanh toán online (Q89 Pay · Stripe Connect) — thêm ngày 2026-10-06, **LIVE từ 2026-10-12**

### Trạng thái live (2026-10-12)

| | |
|---|---|
| Tài khoản nền tảng | **Queenie89 AB** `acct_1UJeoU2FsxVNpiEw` (live) |
| Tài khoản Hanami | **Hanami Family Sushi AB** `acct_1UPgjnCHMrAi25Sw` — Express, Aktiebolag, Sverige, MCC 5812. Nhận thẻ + chuyển khoản: active. Rút về Nordea (IBAN …2797), **mỗi ngày, trễ 7 ngày** (tài khoản mới, Stripe tự rút ngắn sau này) |
| Webhook | `we_1UPgSe2FsxVNpiEwtZbKENLO` → `https://www.hanamisushibar.se/api/stripe/webhook`, API-version `2025-08-27.basil`, 5 händelser (gồm `charge.refunded`) |
| Khoá API | Hemlig nyckel `hanamisushibar-vercel`, **Fullständig åtkomst** (khoá "förutom känsliga åtgärder" chặn överföringar/Connect → destination charge lỗi) |
| Vercel (Production) | `STRIPE_SECRET_KEY` (Secret), `STRIPE_WEBHOOK_SECRET` (Secret), `STRIPE_ACCOUNT`, `STRIPE_VAT_PCT=6`, `SITE_URL=https://www.hanamisushibar.se` |
| Moms | **6 %** inkluderad (thuế thực phẩm tạm giảm). Code tự tạo thuế suất "Moms 6 %" trong Stripe; không tính moms trên dricks |
| Phí nền tảng | 4 % + 2 kr mỗi đơn (`STRIPE_FEE_PCT`/`STRIPE_FEE_FIXED`, mặc định) |
| Lựa chọn trong giỏ | Chỉ **Betala med kort nu** (kort · Apple Pay · Google Pay). "Kort i kassan" bỏ 2026-10-12. **Swish thủ công tạm khoá 2026-10-13** trong lúc làm Swish Handel: `paySwish: false` trong `data/settings.js` → ẩn trên web và `/api/submit` từ chối đơn Swish (chỉ khi Stripe đang chạy; Stripe hỏng thì Swish tự hiện lại để khách vẫn đặt được). Mở lại: đổi thành `paySwish: true` → commit → Vercel tự deploy |
| Thử thật | 12 kr Sushisoja, Apple Pay → đơn **H1022**, phí 2,48 kr, moms 0,68 kr, chuyển sang Hanami; rồi hoàn toàn bộ (tiền + chuyển khoản + phí) — mọi khoản về 0 |

> **Lỗi đã sửa 2026-10-12:** `api/stripe-webhook.js` cũ đọc `req.body` trước. Trên Vercel `req.body` là getter tự parse JSON (`config.api.bodyParser` chỉ có tác dụng với Next.js), Stripe gửi JSON thụt lề → `JSON.stringify` cho byte khác → **mọi webhook bị 400 "Bad signature"**, tiền thu nhưng không có đơn. Nay đọc luồng thô trước; `tests/pay.test.mjs` có test mô phỏng đúng tình huống này.

> Gộp ngày 6/10 với công tắc **Onlinebeställning PÅ/AV** (7.6): khi quán tắt đơn, `/api/pay` cũng bị chặn (423) nên không thu tiền; một thanh toán đã hoàn tất trước khi tắt vẫn tạo đơn vì tiền đã vào. Bật `payOnline` chỉ khi Stripe đã cấu hình xong (xem bên dưới); trong lúc chờ Swish Handel/Stripe, dùng công tắc 7.6 để đóng đặt món.

Khách trả **ngay trong giỏ hàng** bằng kort, Apple Pay hoặc Google Pay qua Stripe. **Swish không đi qua Stripe**: khách swish thẳng tới số của quán như trước (không mất 4 % + 2 kr), nhân viên bấm "Markera betald" trong köksvyn. Hanami là người bán
(tên Hanami hiện trên sao kê và trong app Swish của khách); Queenie89 AB là nền tảng, thu 4 % + 2 kr mỗi đơn tự động.

### Cách chạy

```
Giỏ hàng → "Betala nu" → POST /api/pay → Apps Script payPending (tính giá theo tab Meny, ghi vào tab Betalningar, CHƯA tạo đơn)
         → Stripe Checkout (destination charge, on_behalf_of = tài khoản Hanami)
Khách trả → Stripe webhook → /api/stripe/webhook → Apps Script payConfirm → createOrder_ (Betald = giờ, Betalning = "Online kort/Swish")
         → in bếp (Utskriven), SMS, mejl như đơn thường
Khách bấm huỷ / quá 30 phút → payFail → tab Betalningar ghi "misslyckad"/"utgången", KHÔNG có đơn
Trang /tack?ref&sid poll GET /api/pay tới khi "betald", rồi xoá giỏ hàng.
```

Bếp **không bao giờ** thấy đơn online chưa trả. Giá khoá tại lúc bắt đầu trả; món hết sau đó không ảnh hưởng đơn đã trả.

### File đã thêm / sửa

| File | Việc |
|---|---|
| `apps-script/Pay.js` | mới: payPending, paySession, payConfirm (idempotent, kiểm tra đúng số tiền), payFail, payStatus, dọn rác 2 ngày |
| `apps-script/Orders.js` | tách `priceLines_()` khỏi `createOrder_()`; `createOrder_(p, pre)` nhận dòng đã tính giá; nhãn Betalning "Online kort/Swish"; cột **Stripe** (payment intent) |
| `apps-script/Config.js`, `Setup.js`, `Api.js` | tab mới **Betalningar**, cột **Stripe** trong Beställningar, 5 action mới |
| `apps-script/Notify.js` | mejl khách ghi "Betald online" |
| `apps-script/Refund.js` | (2026-10-12) ghi cột **Återbetald**, mejl hoàn tiền cho khách; action `refundInfo`, `refunded` |
| `lib/routes/admin.js`, `src/kok.html` | (2026-10-12) nút **↩ Återbetala** trong köksvyn → `POST /api/admin {kind:"refund"}` → Stripe `/v1/refunds` |
| `lib/stripe.js` | mới: gọi Stripe REST bằng fetch (không thêm npm), ký/kiểm chữ ký webhook, tính phí, tự tạo/tìm thuế suất (`STRIPE_VAT_PCT`) |
| `lib/routes/pay.js` | mới: POST tạo Checkout, GET trạng thái |
| `lib/routes/submit.js` | tách `buildOrder()` dùng chung; từ chối `payment: online` (phải qua /api/pay) |
| `api/stripe-webhook.js` | mới: function riêng; đọc **luồng thô** trước `req.body` để kiểm chữ ký (sửa 2026-10-12) |
| `api/index.js`, `vercel.json` | route `pay`; rewrite `/api/stripe/webhook`; header no-store cho `/tack` |
| `src/meny.html`, `src/common.js` | lựa chọn "Betala med kort nu" (mặc định khi bật), nút "Betala X kr", quay lại khi huỷ; Swish thủ công giữ nguyên; "Kort i kassan" đã bỏ (2026-10-12) |
| `src/tack.html`, `scripts/build.mjs` | trang cảm ơn `/tack` |
| `data/settings.js` | cờ `payOnline` (false = ẩn lựa chọn online) |
| `tests/pay.test.mjs`, `tests/apps-script.test.cjs` | 14 + 6 test; `npm test` chạy cả |

### Triển khai, theo thứ tự

1. **Apps Script**: `npm run gas:push` rồi trong Sheet chạy **Hanami → setup** một lần (tạo tab Betalningar, thêm cột Stripe). Deploy webapp phiên bản mới (`gas:deploy`).
2. **Stripe – tài khoản Hanami**: Dashboard → chọn tài khoản **Queenie89 AB** (không phải cấp *Organisation* — ở đó không có nút Skapa) → Connect → Anslutna konton.
   - Lần đầu Stripe đòi: **xác minh giấy tờ** của người đại diện Queenie89 AB, rồi **Bekräfta dina integrationsval**: chọn *"Du tar emot betalningar och betalar mottagare"* (marketplace), Stripe-baserad onboarding, Express Dashboard, nền tảng chịu phí Stripe và số dư âm → tick cam kết → Bekräfta.
   - **+ Skapa**: tick **cả hai** *"Ta emot betalningar från sina egna kunder"* và *"Ta emot överföringar"* (code dùng `on_behalf_of` → cần quyền nhận thẻ). E-post quán, Sverige, **Verksamhetsform = Företag/Aktiebolag** (không phải Enskild firma).
   - Gửi link onboarding (hết hạn sau 7 ngày) cho chủ quán: BankID, org.nr, địa chỉ, ngành Restauranger, website, IBAN. Người đại diện phải là VD/styrelse của Hanami theo Bolagsverket. Chép `acct_…` vào Vercel.
   Ô "Business website" của Hanami: `https://www.hanamisushibar.se`. Trước đó web Hanami phải có trang **Integritetspolicy** (mẫu `mall-integritetspolicy/integritetspolicy-sv.html` từ Q89, đã điền) link ở chân trang.
3. **Stripe – nền tảng**: Betalningsmetoder bật Kort, Apple/Google Pay (code khoá `payment_method_types: ["card"]`, nên Swish/Klarna không hiện dù có bật). Moms: **6 %** (`STRIPE_VAT_PCT=6`) – code tự tạo thuế suất "Moms 6 %, inkluderad" trong Stripe ở lần thanh toán đầu, không cần làm tay. Webhook endpoint **`https://www.hanamisushibar.se/api/stripe/webhook`** (phải có `www` – tên miền gốc chuyển hướng 308 sang www và Stripe không theo chuyển hướng) với 4 händelser (xem bảng dưới) → `whsec_…`. *Đã tạo ngày 2026-10-12: `we_1UPgSe2FsxVNpiEwtZbKENLO`.*
4. **Vercel → Environment Variables** (Production):

   | Biến | Giá trị |
   |---|---|
   | `STRIPE_SECRET_KEY` | `sk_live_…` của **Queenie89 AB** (nền tảng), loại Secret, chỉ Production. Tạo: Utvecklare → API-nycklar → Skapa hemlig nyckel → *Bygga din egen integration* → **Fullständig åtkomst**. Test: `sk_test_…` |
   | `STRIPE_WEBHOOK_SECRET` | `whsec_…` |
   | `STRIPE_ACCOUNT` | `acct_…` của Hanami |
   | `STRIPE_VAT_PCT` | `6` (moms %, inkluderad). Hoặc `STRIPE_TAX_RATE` = `txr_…` có sẵn |
   | `STRIPE_FEE_PCT` / `STRIPE_FEE_FIXED` | `4` / `2` (mặc định, có thể bỏ trống) |
   | `SITE_URL` | `https://www.hanamisushibar.se` |

5. Đặt `payOnline: true` trong `data/settings.js` → commit → deploy. Lựa chọn "Betala nu" xuất hiện trong giỏ hàng.
6. **Thử thật một lần**: tự đặt món rẻ nhất, trả bằng thẻ của chị (báo bếp trước – đơn sẽ in ra). Kiểm tra: in ra bếp với dòng **BETALD · ONLINE KORT**, tab Beställningar có cột Stripe, tab Betalningar ghi "betald", Dashboard Stripe hiện charge với *Överföring* sang Hanami và *Plattformsavgift* = 4 % + 2 kr. Rồi hoàn tiền theo mục **Hoàn tiền** bên dưới (đơn thử: tick cả hai ô).

Webhook händelser: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.async_payment_failed`, `checkout.session.expired`, `charge.refunded` (thêm 2026-10-12 cho hoàn tiền).

### Test mode trước khi live
Dùng `sk_test_…`, tạo Express account test, thẻ `4242 4242 4242 4242` (3DS: `4000 0025 0000 3155`, từ chối: `4000 0000 0000 9995`). `stripe listen --forward-to localhost:3000/api/stripe/webhook` với `vercel dev` để nhận webhook ở máy.

### Hoàn tiền — chủ quán tự làm trong köksvyn (từ 2026-10-12)

Chủ quán **không cần vào Stripe**. Trong köksvyn (`/kok`, mật khẩu `ADMIN_KEY`), mỗi đơn trả online (có mã `pi_…` trong cột Stripe) có nút **↩ Återbetala**, kể cả đơn đã Klar/Avbokad:

1. Bấm **↩ Återbetala** → nhập số tiền (mặc định = toàn bộ phần còn lại; hoàn một phần thì gõ số nhỏ hơn, ví dụ món bị thiếu).
2. Xác nhận → xong. Thẻ trên đơn hiện **"Återbetald X kr"**, cột **Återbetald** trong Beställningar ghi số tiền + giờ, tab Logg ghi lại, khách nhận **mejl** (nếu có e-post).
3. Đơn chưa làm mà khách huỷ: hoàn tiền rồi bấm **Avboka** như thường.

Hệ thống tự lo:

| | |
|---|---|
| Kéo tiền lại | luôn từ **tài khoản Stripe của Hanami** (`reverse_transfer`), Queenie89 AB không phải trả thay |
| Phí nền tảng 4 % + 2 kr | **giữ lại** (Villkor för företagskunder §4). Muốn hoàn cả phí: đặt `STRIPE_REFUND_FEE=1` trên Vercel |
| Chặn sai | không hoàn quá số tiền còn lại (Stripe là facit), không dưới 1 kr, không cho đơn Swish/kontant, bấm hai lần không hoàn hai lần (idempotency) |
| Hoàn trong Stripe Dashboard | vẫn được (tick **Upphäv tillhörande överföring**!) — webhook `charge.refunded` tự ghi vào cột Återbetald và gửi mejl |

**Swish / kontant**: như trước, quán trả lại trực tiếp cho khách (Swish app), không qua hệ thống.

Thẻ hoàn về tài khoản khách sau 5–10 ngày ngân hàng. Phí Stripe của giao dịch gốc không được hoàn. Nếu số dư Stripe của Hanami không đủ (tiền đã rút về ngân hàng), Stripe trừ vào lần chuyển tiếp theo; lâu dài âm thì Queenie89 AB chịu trước (đã cam kết khi bật Connect) → đòi lại Hanami theo hợp đồng.

**Cài đặt một lần** (đã làm 2026-10-12 trừ bước 1): (1) `npm run gas:deploy` để đưa `apps-script/Refund.js` lên — chưa deploy thì nút báo lỗi "Okänd action" và **không có tiền nào bị hoàn**; cột Återbetald tự tạo, không cần chạy setup. (2) Webhook thêm sự kiện `charge.refunded`.

Hoàn tay trong Dashboard (dự phòng): Queenie89 AB → Transaktioner → chọn đơn → **Återbetalning** → tick **Upphäv tillhörande överföring** (luôn luôn); *Återbetala ansökningsavgiften* chỉ khi muốn trả cả phí; Orsak *Begärd av kund*; ghi số đơn ở Anmärkning.

### Nếu có lỗi
| Triệu chứng | Xem |
|---|---|
| Nút "Betala nu" không hiện | `payOnline` trong settings.js; build lại |
| Bấm Betala → "Onlinebetalning är inte aktiverad" | thiếu `STRIPE_SECRET_KEY` hoặc `STRIPE_ACCOUNT` trên Vercel |
| Trả xong nhưng /tack báo "Något gick fel / Vi har inte fått bekräftelse" | Stripe → Utvecklare → Webhooks → endpoint → **Händelseleveranser** → bấm lần gửi lỗi: **400 "Bad signature"** = `STRIPE_WEBHOOK_SECRET` không khớp endpoint (hoặc code đọc sai raw body – đã sửa 2026-10-12); **500 "handler error"** = lỗi Apps Script, xem tab Logg; **404/308** = URL thiếu `www`. Sửa xong bấm **Skicka igen** → 200 OK → đơn được tạo, in bếp. Stripe cũng tự gửi lại trong 3 ngày |
| Bấm ↩ Återbetala → "Okänd action: refundInfo" | Apps Script chưa có `Refund.js` → `npm run gas:deploy`. Không có tiền nào bị hoàn |
| Bấm ↩ Återbetala → "Stripe nekade återbetalningen: …" | đọc lý do; thường là số dư Hanami không đủ hoặc thẻ khách đã đóng → hoàn tay trong Dashboard hoặc chuyển Swish cho khách |
| Tab Betalningar có dòng "väntar" mãi | khách mở Stripe nhưng không trả; sau 30 phút thành "utgången", tự xoá sau 2 ngày. Không cần làm gì |
| Dashboard Hanami hiện "Betalningar pausade" / "Åtgärder krävs" ngay sau onboarding | trang cũ chưa tải lại (⌘R). Đừng bấm "Be om information" nếu API/Översikt đã báo active |
| Onboarding báo "Vissa personuppgifter saknas – Registrerat namn" | điền họ tên đầy đủ của người đại diện như trong folkbokföring/Bolagsverket |
| Tab Logg: "Stripe-belopp avviker" | ai đó sửa giá trong tab Meny giữa chừng; đơn không tạo, tiền đã thu → hoàn tiền thủ công từ Dashboard và liên hệ khách |
| Khách trả nhưng Stripe giữ tiền | tài khoản Hanami chưa xác minh xong (`charges_enabled` nhưng `payouts_enabled` = false) → chủ quán bổ sung giấy tờ trong Express Dashboard |

### Báo cáo doanh thu (köksvyn → Rapport) — thêm 2026-10-13

Köksvyn có tab **Rapport** (cùng mật khẩu `ADMIN_KEY`):

- Nút **Dag / Vecka / Månad / År** (thêm Dag và Vecka 2026-10-13). **‹ ›** lùi/tiến một ngày/tuần/tháng/năm, **Idag** về hiện tại.
  - **Dag**: ô tổng của một ngày. **Vecka**: thứ 2–CN (tuần ISO) + bảng 7 ngày. **Månad**: bảng từng ngày. **År**: bảng 12 tháng.
  - Bấm vào một ngày trong bảng → mở ngày đó.
- **Ladda ner CSV**: file cho kế toán (dấu `;`, số thập phân dấu phẩy, mở thẳng trong Excel/Numbers tiếng Thuỵ Điển).

| Ô | Nghĩa |
|---|---|
| Netto | Brutto (Summa gồm dricks) − Återbetalt |
| Online kort / Swish | chia theo cách trả (cột Betalning; online = có `pi_…` trong cột Stripe) |
| Moms 6 % (ingår) | (Netto − Dricks) × 6/106 — dricks không chịu moms. Tỷ lệ lấy từ `STRIPE_VAT_PCT` |
| Ej markerad betald | đơn Swish mà bếp chưa bấm **Betald** → đối chiếu với Swish |

**Từ 2026-10-13:** báo cáo chỉ tính từ ngày `reportFrom` trong `data/settings.js` (= 2026-10-13; e-mail dùng thuộc tính `REPORT_FROM`, mặc định cùng ngày) — mọi đơn trước đó là thử. Đơn **Kort i kassan** không tính nữa (cách trả này đã bỏ, các đơn đó là thử). Chỉ còn **Online kort** và **Swish**.
Quy tắc: ngày = **Mottagen** (lúc nhận đơn). Đơn **Avbokad** không tính, trừ đơn đã trả online (tiền đã thu; phần hoàn hiện ở Återbetalt).
Dữ liệu đọc từ **cả Sheet chính và Arkiv** (nightlyCleanup chuyển đơn > 30 ngày sang file Arkiv — `ARCHIVE_ID`), nên tháng cũ vẫn đủ. Mỗi lần xem tối đa 13 tháng.
Code: `apps-script/Report.js` (action `reportOrders`), `lib/report.js` (cộng tổng, CSV), `lib/routes/admin.js` (`GET ?view=report`), `src/kok.html`; test `tests/report.test.mjs`.
Cài đặt: đưa `Report.js` (mới) và `Api.js` lên Apps Script → Triển khai → Phiên bản mới. Chưa đưa lên thì tab Rapport báo "Okänd action: reportOrders".

### Báo cáo qua e-mail (cả ngày đến 23:59:59, gửi 00:01) — thêm 2026-10-13, đổi giờ 2026-11-02

- **Hằng ngày, tính đủ 00:00:00–23:59:59** (đổi 2026-11-02, vì khách đặt 24/7): gửi lúc **00:01** đêm đó, khi ngày đã kết thúc — đơn đến giây cuối 23:59:59 đều có. E-mail "📊 Dagsrapport …" — netto, số đơn, theo cách trả, dricks, hoàn tiền, moms, cảnh báo *Ej markerad betald*.
- **Hoa hồng Q89 (4 % + 2 kr) KHÔNG hiện** trong Rapport, CSV hay e-mail của quán (bỏ 2026-10-13). Theo dõi trong Stripe Dashboard của Queenie89 AB → Connect → *Plattformsavgifter* (Application fees).
- E-mail ngày **kèm file PDF `Hanami_dagsrapport_ÅÅÅÅ-MM-DD.pdf`** kiểu báo cáo ngày của máy tính tiền (thêm 2026-10-13): thông tin công ty/org.nr, ngày bán, giờ xuất; Total försäljning, moms 6 %, theo cách trả, dricks, sålda varor, returer; rồi **từng nhóm món** (theo thứ tự tab Meny) với số lượng và tiền từng món; cuối là Grand total försäljning / retur / netto. Không có hoa hồng Q89. Code: `dailyDetail_`, `dailyPdfHtml_` trong `ReportMail.js`.
- **Hết thứ Bảy (gửi 00:03 đêm T7→CN): Avstämningsrapport (PDF) tuần CN–T7** (đổi 2026-10-13; quán nghỉ Chủ nhật nhưng đơn đặt trước vào CN được tính vào tuần kết thúc thứ Bảy) (thêm 2026-10-13, giống mẫu FoodTec): Översikt (ex. moms / moms / inkl.), Försäljning per momssats (0 % dricks, 6 %), per betalmetod (Kort online / Swish), **Avgifter per betalmetod** và **Utbetalningssummering**: kort online − hoàn tiền − **Transaktionsavgift** (4 % + 2 kr mỗi đơn online, tách 25 % moms: `FEE_VAT_PCT`) = **Utbetalas via Stripe**. Swish ghi là trả thẳng cho quán, không phí. Không có chữ Q89. Code `apps-script/WeeklyReport.js`; giờ chính xác nhờ trigger một lần `sendPeriodReports` 00:03 do `scheduleReportMail` (~12h) đặt. Thử: *Hanami → Rapporter per e-post → Skicka veckorapport nu*.
- **Hết ngày cuối tháng (gửi 00:03 ngày 1): Avstämningsrapport (PDF) cả tháng** đến 23:59:59 ngày cuối (cùng mẫu báo cáo tuần). File `Hanami_avstamning_ÅÅÅÅ-MM.pdf`. Thử: *Skicka månadsrapport nu (denna månad, test)*.
- Cùng quy tắc tính như tab Rapport (đọc cả Arkiv). Gửi tối đa 1 lần/ngày.
- Người nhận: thuộc tính `REPORT_EMAIL` (nhiều địa chỉ cách nhau dấu phẩy), không có thì `NOTIFY_EMAIL`. Đặt ở Apps Script → ⚙️ Cài đặt dự án → Thuộc tính tập lệnh.
- Giờ chính xác: Apps Script không hẹn đúng phút được, nên trigger `scheduleReportMail` (~12 giờ trưa) tạo trigger một lần `sendReportMail` đúng 00:01 đêm đó (và `sendPeriodReports` 00:03 nếu hôm đó là T7/cuối tháng). Ngày báo cáo = `reportDay_()`: chạy trước 06:00 → hôm qua. Sau khi đưa code mới lên phải bấm **Slå på** một lần để thay trigger 20:05 cũ.
- **An toàn (thêm 2026-11-03):** nếu báo cáo đêm bị lỡ (trigger không chạy, lỗi, code chưa cập nhật), trigger ~12h trưa tự gửi bù báo cáo hôm qua. Menu: *Skicka gårdagens dagsrapport nu* (gửi lại hôm qua), *Kontrollera rapporterna* (người nhận, trigger, ngày đã gửi gần nhất, dòng Logg gần nhất).
- **Bật**: Google Sheet → **Hanami → Rapporter per e-post → Slå på**. Thử ngay: *Skicka dagsrapport nu (test)* / *Skicka månadsrapport nu (test)*. Tắt: *Stäng av*.
- Code: `apps-script/ReportMail.js`, menu trong `Setup.js`. Phí/moms lấy từ thuộc tính `STRIPE_FEE_PCT`, `STRIPE_FEE_FIXED`, `STRIPE_VAT_PCT` (mặc định 4 / 2 / 6).

### Chỉ dùng e-mail, không SMS — 2026-11-05

- Quán **không gửi SMS** cho khách nữa. Mọi thông báo đi bằng **e-mail**: xác nhận đơn + kvitto, "maten är klar", nhận yêu cầu đặt bàn, đã xác nhận / từ chối đặt bàn.
- **Đặt bàn bắt buộc e-mail** (trước là tuỳ chọn) vì xác nhận gửi qua mail. Số điện thoại vẫn bắt buộc để quán gọi khi cần.
- Chữ trên web đổi theo: "Vi bekräftar via mejl", köksvyn ghi "bekräftelse‑mejl", "klar-mejl".
- Muốn bật lại SMS sau này: Apps Script → Thuộc tính tập lệnh → `SMS_ENABLED` = `on` (cần SMSGATE_* hoặc ELKS_*). Mặc định tắt.

### Mail "maten är klar" khi bếp bấm Klar — thêm 2026-11-05

- Bếp bấm **Klar** (đơn mang về) → khách nhận **e-mail "Din mat är klar att hämta"** (số đơn, địa chỉ, số điện thoại). Nếu SMS đã cài thì vẫn gửi SMS kèm. Chỉ gửi **1 lần** mỗi đơn; cột `Sms klar` ghi giờ đã báo, köksvyn hiện "klar-mejl HH:mm".
- Mọi chỗ trên web trước ghi "vi sms:ar" nay ghi **"du får ett mejl när maten är klar"**: giỏ hàng (ô E-post), màn hình đặt xong, trang /tack sau thanh toán, nút nổi, trang thanh toán Stripe, và SMS xác nhận đơn.
- Code: `mailOrderReady_` (Notify.js), `afterStatusChange_` (Orders.js); test trong `tests/apps-script.test.cjs`.

### Utbetalningar – tiền Stripe chuyển vào ngân hàng, đối chiếu với doanh thu trên web — thêm 2026-11-02

- **Xem:** `/kok` → tab **Utbetalningar** → chọn **Vecka** hoặc **Månad**.
  - Ô trên cùng: **Utbetalt till banken** (đã vào tài khoản ngân hàng trong kỳ), **På väg** (Stripe đã chuyển, ngân hàng chưa nhận), **Väntar hos Stripe** (số dư chưa chuyển – chỉ hiện khi xem kỳ hiện tại), **Webben: kortförsäljning**, **Ska till banken** (= thẻ online − hoàn tiền − phí giao dịch), **Stripe har bokat**, **Skillnad** (phải = 0).
  - Bảng **Utbetalningar till bankkontot**: mỗi lần Stripe chuyển tiền — ngày tiền vào ngân hàng, số tiền, trạng thái, số đơn, phí, hoàn tiền, đơn của những ngày nào. Bấm một dòng để xem từng đơn (H-số).
  - Bảng **Avstämning per dag**: mỗi ngày bán — web vs Stripe, cột Skillnad (✓ hoặc số đỏ), trạng thái *Utbetald 5/11 / På väg / Väntar hos Stripe*.
  - **Ladda ner CSV** cho kế toán (cả 2 bảng).
- **E-mail báo cáo ngày (00:01)** có thêm mục **"Kort online → ert bankkonto (Stripe)"**: bán thẻ hôm đó, phải về ngân hàng, Stripe đã ghi, chênh lệch, trạng thái, và số tiền Stripe chuyển vào ngân hàng hôm đó.
- Swish không qua Stripe (tiền vào thẳng Swish của quán) nên không có ở đây.
- Hoàn tiền làm vào ngày khác ngày đặt đơn → ngày đơn hiện −, ngày hoàn hiện +; tổng kỳ vẫn = 0.
- Nguồn: tài khoản Stripe của quán (`STRIPE_ACCOUNT`) — payouts + balance transactions; nối với đơn qua cột **Stripe** (pi_…) trong Sheet. Code `lib/payouts.js`, `GET /api/admin?view=payouts`, `GET /api/platform?kind=payouts` (cho Apps Script), `src/kok.html`; test `tests/payouts.test.mjs`.
- Cài: đưa `Report.js` và `ReportMail.js` lên Apps Script → Phiên bản mới. Web tự cập nhật qua Vercel.

### Báo cáo lợi nhuận Q89 (cho Queenie89 AB, KHÔNG gửi quán) — thêm 2026-10-13

- **Mỗi sáng ~07:00** e-mail "💼 Q89 Pay ÅÅÅÅ-MM-DD · resultat …" cho **cả ngày hôm qua** (00:00–24:00), lấy thẳng từ sổ Stripe của tài khoản nền tảng (balance transactions):
  - **Resultat** = Q89-avgifter (4 % + 2 kr) − hoa hồng đã hoàn − phí thẻ Stripe − phí Stripe khác (Connect …)
  - **Pengar som passerar**: tiền khách trả, hoàn cho khách, chuyển cho quán, quán trả lại khi hoàn tiền, rút về ngân hàng Q89, thay đổi số dư, số dư hiện tại
  - **Từng đơn**: giờ, đơn, tiền, Q89 (+), Stripe (−), còn lại
- Ví dụ thật 13/10: đơn 489 kr → +21,56 − 9,14 = **12,42 kr**.
- Người nhận: thuộc tính **`PLATFORM_EMAIL`** (bắt buộc; không bao giờ gửi tới `NOTIFY_EMAIL`/`REPORT_EMAIL` của quán). Tab Logg chỉ ghi "đã gửi", không ghi số tiền.
- Bật: **Hanami → Q89 plattformsrapport → Slå på**. Thử: *Skicka för idag (hittills)* / *Skicka för igår*.
- Bảo mật: số liệu do Vercel tính tại `/api/platform` (`lib/platform.js`), chỉ mở bằng khoá `GAS_SECRET` = API_SECRET của Apps Script; mật khẩu köksvyn không mở được.
- ⚠️ Ai có quyền **sửa** Apps Script/Google Sheet này thì xem được code và thuộc tính. Nếu chủ quán có quyền sửa Sheet, nên chuyển phần này sang một Apps Script riêng của Q89.

### Dữ liệu cá nhân
Tab Betalningar chứa bản sao đơn (tên, điện thoại) **chỉ trong lúc chờ thanh toán**. Khi trả xong, `payConfirm` xoá bản sao đó (chỉ giữ loại đơn + số bàn); dữ liệu khách nằm duy nhất ở Beställningar và theo Cleanup như trước. Dòng chưa trả xoá sau 2 ngày. Không cần sửa `Cleanup.js`.

Lưu ý khớp văn bản pháp lý: Cleanup của Hanami ẩn danh sau **12 tháng** (thoả thuận với quán). Mẫu Integritetspolicy Q89 gửi phải điền `{{ANONYMISERING}}` = "12 månader" cho Hanami.

## Swish Handel (API) — thêm ngày 2026-10-14

Khách chọn **Swish** khi đặt món:
- **Điện thoại:** app Swish tự mở, số tiền đã điền sẵn.
- **Máy tính:** trang hiện mã QR để khách quét bằng điện thoại.

Đơn chỉ vào bếp **sau khi Swish xác nhận đã trả** (giống thanh toán thẻ). Tiền vào thẳng tài khoản Swish Handel của quán tại Nordea, số **123 706 67 56**. Q89 không thu phí phần này, còn phí giao dịch Swish thì Nordea tính riêng.

### Cài một lần (đã làm 2026-10-14)
1. **Xin quyền:** Nordea cấp quyền vào portal.swish.nu (Swish Företagsportal → Certifikat).
2. **Tạo khoá trên Mac:**
   ```
   mkdir -p ~/swish && cd ~/swish
   openssl genrsa -out hanami-swish.key 4096
   openssl req -new -key hanami-swish.key -out hanami-swish.csr -subj "/CN=Hanami Sushi Bar"
   ```
   **Không gửi file `.key` cho bất kỳ ai.**
3. **Tạo chứng chỉ:** vào portal → Nytt certifikat → **Hoppa över** → tải `hanami-swish.csr` lên → Generera → Ladda ner. Đổi tên file tải về thành `~/swish/hanami-swish.pem`.
4. **Thêm biến trên Vercel** (Settings → Environment Variables, chọn Sensitive):
   - `SWISH_CERT` = kết quả của `base64 -i ~/swish/hanami-swish.pem`
   - `SWISH_KEY` = kết quả của `base64 -i ~/swish/hanami-swish.key`
   - `SWISH_PAYEE` = `1237066756`
   - Tuỳ chọn: `SWISH_CA`, chỉ cần khi Vercel báo lỗi chứng chỉ máy chủ Swish.
5. **Bật/tắt:** đặt `swishApi: true` trong `data/settings.js`. Lựa chọn Swish chỉ hiện khi đủ 3 biến trên Vercel.
6. **Gia hạn:** chứng chỉ có hạn khoảng 2 năm. Gần hết hạn thì lặp lại bước 2–4.

### Cách chạy
| Bước | Ở đâu |
|---|---|
| Khách bấm "Betala … med Swish" | `POST /api/pay` (payment `swishapi`) → `lib/swish.js` tạo yêu cầu thanh toán |
| Trang `/tack` | Mở `swish://paymentrequest?token=…` trên điện thoại, hoặc hiện QR qua `GET /api/pay?qr=…` trên máy tính. Hỏi trạng thái mỗi 2 giây |
| Swish báo kết quả | `POST /api/swish` (callback). Server **luôn hỏi lại Swish** bằng chứng chỉ trước khi ghi vào Sheet, vì callback không có chữ ký |
| Tạo đơn | Apps Script `payConfirm` (method `swish`). Cột Betalning = "Online Swish – BETALD", cột Stripe = `swish:<paymentReference>` |
| Hoàn tiền | Köksvyn → nút **↩ Återbetala**. Tiền rút từ tài khoản Swish của quán, trả thẳng về Swish của khách |

### Lưu ý
- Yêu cầu thanh toán Swish có hạn 3 phút. Khách không trả kịp thì đơn không được tạo, giỏ hàng vẫn còn.
- Báo cáo: đơn Swish nằm ở cột **Swish**, không bị trừ Transaktionsavgift.
- **Hoàn tiền Swish cần đủ số dư trong tài khoản Swish Handel.** Nếu Swish từ chối (ví dụ lỗi AM04), köksvyn sẽ báo lỗi rõ ràng.

## Màn hình TV cho khách (`/skarm`) — thêm ngày 2026-10-14

Trên TV mở trình duyệt và vào **hanamisushibar.se/skarm**. Màn hình chia hai cột, tự cập nhật mỗi 10 giây:
- **TILLAGAS** (đang làm): các đơn có trạng thái Ny và Tillagas, đơn cũ nhất đứng đầu.
- **KLAR ATT HÄMTA** (xong, chờ lấy): các đơn có trạng thái Klar. Số mới chuyển sang Klar sẽ nhấp nháy trong 1,5 phút và kêu "pling", nếu đã bật âm thanh.

Bếp không phải làm gì thêm. Bấm **Klar** trong köksvyn thì số đơn tự chuyển sang cột phải. Bấm **Hämtad** thì số đơn biến mất khỏi màn hình.

- **Samsung TV:** mở ứng dụng **Internet**, gõ địa chỉ trên, để zoom 100% rồi bấm nút toàn màn hình. Bấm **OK** trên điều khiển một lần để bật âm thanh.
- **TV tự tắt:** đây là cài đặt của TV, trang web không chặn được. Vào Cài đặt → Chung → **Giải pháp tiết kiệm (Eco Solution) → Tự động tắt nguồn: Tắt**. Vào Cài đặt → Chung → Quản lý hệ thống → **Thời gian tự bảo vệ (Auto Protection Time): Tắt**. Kiểm tra thêm **Hẹn giờ tắt (Sleep Timer): Tắt**.
- Trang được viết cho trình duyệt TV đời cũ: không dùng CSS variables, flexbox hay thẻ HTML5.
- **Hiện cả đơn tại bàn:** dùng địa chỉ `hanamisushibar.se/skarm?bord=1`.
- **Bảo mật:** màn hình chỉ hiện số đơn và giờ lấy, không hiện tên, số điện thoại hay số tiền. Dữ liệu lấy qua `/api/board` (`lib/routes/board.js`).
- **TV đời cũ:** nếu trình duyệt của TV quá chậm hoặc không chạy được, cắm một **Chromecast with Google TV** hoặc **Fire TV Stick** (khoảng 500–700 kr) rồi mở cùng địa chỉ.

### Lưu ý khi đăng bản mới (Vercel Hobby)
- Gói miễn phí giới hạn số lần đăng mỗi ngày. Nếu GitHub hiện "Deployment rate limited", phải chờ khoảng 24 giờ, rồi push thêm một commit mới (hoặc bấm Redeploy trên Vercel) thì bản mới nhất mới lên.
- Vì vậy nên gom nhiều thay đổi nhỏ vào một lần push.
- Chữ hiển thị cho chủ quán và khách **không nhắc tên Stripe**: dùng "Till ditt bankkonto", "Transaktionsavgift", "Säker kortbetalning". Chỉ trang Köpvillkor còn nêu tên Stripe, vì GDPR yêu cầu nêu bên xử lý dữ liệu thẻ.

## SMS miễn phí qua điện thoại Android (sms-gate.app) — thêm ngày 2026-10-19

Hệ thống gửi SMS cho khách qua một điện thoại Android của quán, dùng gói cước có SMS miễn phí của điện thoại đó. Không mất phí cho từng tin. Tin nhắn hiện **số điện thoại của máy** là người gửi, không hiện chữ "Hanami".

1. Lấy một điện thoại Android, lắp SIM có gói **fria sms**. Để máy luôn cắm sạc và luôn có wifi hoặc 4G.
2. Cài app **SMS Gateway for Android** (trên Google Play, hoặc tải tại sms-gate.app).
3. Mở app, bật **Cloud server**, rồi bấm **Online**. App sẽ hiện **Username** và **Password**.
4. Vào Google Sheet → Tiện ích → Apps Script → ⚙ Cài đặt dự án → **Thuộc tính tập lệnh**, thêm 2 dòng:
   - `SMSGATE_USER` = Username trong app
   - `SMSGATE_PASSWORD` = Password trong app
5. Trong cài đặt pin của Android, chọn **Không tối ưu hoá pin** cho app này. Nếu không, máy sẽ tắt app khi tiết kiệm pin.
6. Thử nghiệm: trong köksvyn, bấm **Klar** cho một đơn có số điện thoại của bạn.

- Nếu vẫn còn `ELKS_USER`/`ELKS_PASSWORD` thì 46elks thành **dự phòng**: khi điện thoại tắt hoặc mất mạng, SMS vẫn được gửi qua 46elks (mất phí).
- Gửi lỗi thì tab **Logg** trong Sheet ghi "Sms via telefonen misslyckades".
- Nên kiểm tra điều khoản nhà mạng: có gói "fria sms" không cho phép gửi tin tự động hoặc gửi số lượng lớn.
