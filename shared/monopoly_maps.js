// The boards that ship with the game.
//
// Each one is a *locality*: its 22 buyable squares are streets, wards and
// landmarks you could walk to in that place, which is what a Monopoly board has
// always been — the streets of one town, not a world atlas. The one exception is
// `vietnam`, which zooms out to the provinces and cities as they stand after the
// 1 July 2025 reorganisation, for a room that wants the whole country.
//
// A map is only names, icons and notes: prices, rents and the layout come from
// the ladder in shared/monopoly.js, so a new city is an afternoon of local
// knowledge and no balancing. Places are listed cheapest first — that ordering
// *is* the pricing, so putting Đồng Khởi last is what makes it the dear one.
//
// Anybody can load their own; these are the ones that come in the box.

import { buildBoard } from "./monopoly.js";

/**
 * Compact form: `[name, icon, note?, scene?]`, so a 22-entry list reads as a list.
 *
 * `scene` names a drawing in shared/monopoly_art.js — the picture behind the name
 * on the board and across the top of the deed card. A board that names none still
 * gets pictures, from a rotation; naming them is how a board gets the *right*
 * ones, which is the difference between a decorated board and an illustrated one.
 *
 * @param {[string, string, string?, string?][]} rows
 */
function places(rows) {
  return rows.map(([name, icon, note, scene]) => ({
    name,
    icon,
    note: note ?? "",
    scene: scene ?? "",
  }));
}

/** @param {[string, string][]} rows */
function groups(rows) {
  return rows.map(([name, icon]) => ({ name, icon }));
}

const VIETNAM = buildBoard({
  id: "vietnam",
  name: "Việt Nam",
  icon: "🇻🇳",
  region: "Toàn quốc",
  note: "34 tỉnh và thành phố sau sắp xếp ngày 1/7/2025",
  scene: "bandovn",
  groups: groups([
    ["Tây Bắc", "🏔️"],
    ["Đông Bắc", "🌄"],
    ["Trung du miền núi", "🍵"],
    ["Bắc Trung Bộ", "🪷"],
    ["Tây Nguyên", "☕"],
    ["Miền Trung ven biển", "🏝️"],
    ["Cảng biển và đồng bằng", "🚢"],
    ["Đô thị lớn", "🌆"],
  ]),
  // The notes say what each unit *is now*, which after 1 July 2025 means saying
  // what it absorbed. Somebody looking at "Tuyên Quang 320K" and wondering why it
  // is not cheap deserves to read "hợp nhất với Hà Giang" rather than to go and
  // look it up.
  places: places([
    ["Lai Châu", "🏔️", "Giữ nguyên · biên giới Việt – Trung, cửa khẩu Ma Lù Thàng", "nui"],
    ["Điện Biên", "🎖️", "Giữ nguyên · lòng chảo Mường Thanh, Điện Biên Phủ", "ruong"],
    ["Cao Bằng", "🏞️", "Giữ nguyên · thác Bản Giốc, công viên địa chất non nước", "thacnuoc"],
    ["Tuyên Quang", "🌲", "Hợp nhất với Hà Giang · Tân Trào và cao nguyên đá Đồng Văn", "rung"],
    ["Lạng Sơn", "🛃", "Giữ nguyên · cửa khẩu Hữu Nghị, chợ Đông Kinh", "cuakhau"],
    ["Sơn La", "🐄", "Giữ nguyên · cao nguyên Mộc Châu, chè và sữa", "che"],
    ["Thái Nguyên", "🏭", "Hợp nhất với Bắc Kạn · gang thép, điện tử, hồ Ba Bể", "nhamay"],
    ["Lào Cai", "🚞", "Hợp nhất với Yên Bái · Sa Pa, Fansipan, Mù Cang Chải", "deo"],
    ["Hà Tĩnh", "⚙️", "Giữ nguyên · khu kinh tế và cảng nước sâu Vũng Áng", "cang"],
    ["Thanh Hóa", "🏖️", "Giữ nguyên · biển Sầm Sơn, thành nhà Hồ", "bien"],
    ["Nghệ An", "🪷", "Giữ nguyên · Làng Sen, biển Cửa Lò, cửa khẩu Nậm Cắn", "sen"],
    ["Đắk Lắk", "☕", "Hợp nhất với Phú Yên · cà phê Buôn Ma Thuột, biển Tuy Hòa", "caphe"],
    ["Lâm Đồng", "🌸", "Hợp nhất với Đắk Nông và Bình Thuận · Đà Lạt tới Mũi Né", "hoa"],
    ["Gia Lai", "⛵", "Hợp nhất với Bình Định · cao nguyên và cảng Quy Nhơn", "thuyen"],
    ["Huế", "🏯", "Thành phố trực thuộc trung ương · kinh thành triều Nguyễn", "hoangthanh"],
    ["Đà Nẵng", "🌉", "Hợp nhất với Quảng Nam · cầu Rồng, Hội An, Mỹ Sơn", "cauvong"],
    ["Khánh Hòa", "🏝️", "Hợp nhất với Ninh Thuận · vịnh Nha Trang, Cam Ranh", "dao"],
    ["Cần Thơ", "🛶", "Hợp nhất với Sóc Trăng và Hậu Giang · thủ phủ miền Tây", "songnuoc"],
    ["Quảng Ninh", "⛴️", "Giữ nguyên · vịnh Hạ Long, cửa khẩu Móng Cái", "karst"],
    ["Hải Phòng", "🚢", "Hợp nhất với Hải Dương · cảng lớn nhất miền Bắc", "cang"],
    ["Hà Nội", "🏛️", "Thủ đô · Ba Đình, Hồ Gươm, Hồ Tây", "thudo"],
    [
      "TP. Hồ Chí Minh",
      "🌆",
      "Hợp nhất với Bình Dương và Bà Rịa – Vũng Tàu · ra tới cảng Cái Mép",
      "dothi",
    ],
  ]),
  transport: places([
    ["Sân bay Nội Bài", "✈️", "Cửa ngõ hàng không phía Bắc", "sanbay"],
    ["Đường sắt Bắc – Nam", "🚆", "Nối hai đầu đất nước", "tauhoa"],
    ["Cảng biển quốc tế", "🛳️", "Hàng hoá ra vào cả nước", "cangbien"],
    ["Sân bay Tân Sơn Nhất", "🛫", "Cửa ngõ hàng không phía Nam", "sanbay"],
  ]),
  utilities: places([
    ["Điện lực EVN", "⚡", "Tiền thuê tính theo số xúc xắc", "dienluc"],
    ["Nhà máy nước sạch", "💧", "Tiền thuê tính theo số xúc xắc", "nuocsach"],
  ]),
});

const HANOI = buildBoard({
  id: "hanoi",
  name: "Hà Nội",
  icon: "🏛️",
  region: "Thủ đô",
  note: "Từ đường vành đai vào tới Tràng Tiền",
  scene: "thudo",
  groups: groups([
    ["Vùng ven", "🛣️"],
    ["Cửa ngõ phía Nam", "🚦"],
    ["Cầu Giấy – Thanh Xuân", "🎓"],
    ["Đống Đa – Ba Đình", "🏛️"],
    ["Hồ Tây", "🌅"],
    ["Phố cổ", "🏮"],
    ["Hoàn Kiếm", "🛍️"],
    ["Trung tâm", "💠"],
  ]),
  places: places([
    ["Đường Cổ Linh", "🛣️", "Long Biên, bên kia sông Hồng", "duongpho"],
    ["Đường Tam Trinh", "🏗️", "Kho bãi và công trường", "nhamay"],
    ["Đường Giải Phóng", "🚏", "Trục vào thành phố từ phía Nam", "duongpho"],
    ["Đường Trường Chinh", "🚦", "Vành đai 2, tắc giờ cao điểm", "duongpho"],
    ["Đường Nguyễn Trãi", "🏭", "Hà Đông đi vào trung tâm", "nhamay"],
    ["Đường Xuân Thủy", "🎓", "Khu các trường đại học", "dothi"],
    ["Đường Nguyễn Chí Thanh", "🌳", "Từng là con đường đẹp nhất", "rung"],
    ["Đường Trần Duy Hưng", "🏢", "Cao ốc và văn phòng", "dothi"],
    ["Phố Tây Sơn", "📚", "Hàng sách và quán sinh viên", "cho"],
    ["Đường Kim Mã", "🚕", "Bến xe Kim Mã cũ", "duongpho"],
    ["Phố Nguyễn Thái Học", "🏛️", "Sát Ba Đình, hàng cây cổ", "thudo"],
    ["Đường Thanh Niên", "🌅", "Giữa hồ Tây và hồ Trúc Bạch", "hocuoc"],
    ["Phố Trịnh Công Sơn", "🎶", "Phố đi bộ ven hồ Tây", "hocuoc"],
    ["Đường Võ Chí Công", "🌉", "Ra cầu Nhật Tân", "cauvong"],
    ["Phố Hàng Mã", "🏮", "Đèn lồng và đồ trang trí", "denlong"],
    ["Phố Hàng Bạc", "💍", "Nghề kim hoàn lâu đời", "phoco"],
    ["Phố Đồng Xuân", "🧺", "Chợ đầu mối trong phố cổ", "cho"],
    ["Phố Hàng Bài", "🛍️", "Mặt bằng bán lẻ đắt nhất phố", "dothi"],
    ["Phố Bà Triệu", "🏬", "Trung tâm thương mại và cửa hiệu", "dothi"],
    ["Phố Huế", "🧵", "Vải vóc và đồ gia dụng", "cho"],
    ["Phố Tràng Tiền", "🍦", "Kem Tràng Tiền, Nhà hát Lớn", "phoco"],
    ["Phố Ngô Quyền", "🏨", "Khách sạn và biệt thự Pháp cổ", "phoco"],
  ]),
  transport: places([
    ["Ga Hà Nội", "🚉", "Đầu mối đường sắt Bắc – Nam", "tauhoa"],
    ["Sân bay Nội Bài", "✈️", "Cách trung tâm 30 km", "sanbay"],
    ["Bến xe Giáp Bát", "🚌", "Xe khách các tỉnh phía Nam", "duongpho"],
    ["Metro Nhổn – Ga Hà Nội", "🚇", "Đường sắt đô thị tuyến 3", "tauhoa"],
  ]),
  utilities: places([
    ["Điện lực Hà Nội", "⚡", "Tiền thuê tính theo số xúc xắc", "dienluc"],
    ["Nước sạch Hà Nội", "💧", "Tiền thuê tính theo số xúc xắc", "nuocsach"],
  ]),
});

const SAIGON = buildBoard({
  id: "hcmc",
  name: "TP. Hồ Chí Minh",
  icon: "🌆",
  region: "Thành phố",
  note: "Từ quốc lộ vùng ven vào tới Đồng Khởi",
  scene: "dothi",
  groups: groups([
    ["Vùng ven", "🛣️"],
    ["Tân Bình – Gò Vấp", "🚦"],
    ["Bình Thạnh – Phú Nhuận", "🍜"],
    ["Quận 5 – Chợ Lớn", "🏮"],
    ["Quận 3", "📖"],
    ["Quận 1 ven sông", "🌊"],
    ["Quận 1 trung tâm", "🏛️"],
    ["Phố đi bộ", "💠"],
  ]),
  places: places([
    ["Đường Nguyễn Văn Linh", "🛣️", "Đại lộ nối Nam Sài Gòn", "duongpho"],
    ["Quốc lộ 13", "🚛", "Trục hàng hoá đi Bình Dương", "nhamay"],
    ["Đường Cộng Hòa", "🚦", "Sát sân bay, tắc quanh năm", "duongpho"],
    ["Đường Quang Trung", "🏪", "Chợ và cửa hàng Gò Vấp", "cho"],
    ["Đường Phan Văn Trị", "☕", "Quán cà phê và ăn tối", "duongpho"],
    ["Đường Phan Xích Long", "🍜", "Cả phố là hàng ăn", "cho"],
    ["Đường Nguyễn Văn Trỗi", "🏢", "Trục từ sân bay vào trung tâm", "dothi"],
    ["Đường Điện Biên Phủ", "🛵", "Sáu làn xe qua Bình Thạnh", "duongpho"],
    ["Đường Trần Hưng Đạo", "🏮", "Nối Quận 1 với Chợ Lớn", "phoco"],
    ["Đường Nguyễn Trãi", "👕", "Phố thời trang bình dân", "cho"],
    ["Đường Châu Văn Liêm", "🥮", "Phố người Hoa lâu đời", "denlong"],
    ["Đường Võ Văn Tần", "📖", "Trường học và nhà sách", "phoco"],
    ["Đường Nam Kỳ Khởi Nghĩa", "🌳", "Hàng cây và biệt thự cũ", "phoco"],
    ["Đường Cách Mạng Tháng Tám", "🏫", "Trục dài xuyên Quận 3", "duongpho"],
    ["Đường Tôn Đức Thắng", "🌊", "Bờ sông Sài Gòn", "songnuoc"],
    ["Đường Võ Văn Kiệt", "⛴️", "Đại lộ ven kênh Tàu Hủ", "songnuoc"],
    ["Đường Hàm Nghi", "🏦", "Ngân hàng và chợ Bến Thành", "dothi"],
    ["Đường Lê Lợi", "🎭", "Nhà hát Thành phố", "dothi"],
    ["Đường Pasteur", "🏛️", "Công sở và hàng me", "phoco"],
    ["Đường Nguyễn Thị Minh Khai", "🌿", "Qua Thảo Cầm Viên", "rung"],
    ["Đường Nguyễn Huệ", "💐", "Phố đi bộ, đường hoa Tết", "hoa"],
    ["Đường Đồng Khởi", "👜", "Mặt bằng đắt nhất Việt Nam", "dothi"],
  ]),
  transport: places([
    ["Sân bay Tân Sơn Nhất", "✈️", "Sân bay đông nhất cả nước", "sanbay"],
    ["Ga Sài Gòn", "🚉", "Điểm cuối đường sắt Bắc – Nam", "tauhoa"],
    ["Bến xe Miền Đông", "🚌", "Xe khách đi các tỉnh phía Bắc", "duongpho"],
    ["Metro Bến Thành – Suối Tiên", "🚇", "Tuyến metro số 1", "tauhoa"],
  ]),
  utilities: places([
    ["Điện lực EVNHCMC", "⚡", "Tiền thuê tính theo số xúc xắc", "dienluc"],
    ["Nước sạch Sawaco", "💧", "Tiền thuê tính theo số xúc xắc", "nuocsach"],
  ]),
});

const DANANG = buildBoard({
  id: "danang",
  name: "Đà Nẵng",
  icon: "🌉",
  region: "Thành phố",
  note: "Từ vành đai vào tới bờ sông Hàn",
  scene: "cauvong",
  groups: groups([
    ["Vùng ven", "🛣️"],
    ["Thanh Khê", "🚦"],
    ["Liên Chiểu – Cẩm Lệ", "🎓"],
    ["Ven vịnh", "🌅"],
    ["Sơn Trà", "🛵"],
    ["Biển Mỹ Khê", "🏝️"],
    ["Hải Châu", "🏬"],
    ["Bờ sông Hàn", "💠"],
  ]),
  places: places([
    ["Đường Trường Chinh", "🛣️", "Cửa ngõ phía Tây", "duongpho"],
    ["Đường Tôn Đức Thắng", "🚛", "Trục hàng hoá ra Liên Chiểu", "nhamay"],
    ["Đường Điện Biên Phủ", "🚦", "Vào trung tâm từ quốc lộ", "duongpho"],
    ["Đường Hùng Vương", "🏪", "Chợ Cồn và phố buôn bán", "cho"],
    ["Đường Ông Ích Khiêm", "🧺", "Chợ đầu mối và hàng khô", "cho"],
    ["Đường Lê Duẩn", "🎓", "Đại học Đà Nẵng", "dothi"],
    ["Đường Nguyễn Văn Linh", "🏢", "Trục văn phòng ra cầu Rồng", "dothi"],
    ["Đường Hàm Nghi", "☕", "Quán cà phê và nhà hàng", "duongpho"],
    ["Đường Nguyễn Tất Thành", "🌅", "Đường biển vịnh Đà Nẵng", "bien"],
    ["Đường Nguyễn Chí Thanh", "🏨", "Khách sạn trung tâm", "dothi"],
    ["Đường Phan Châu Trinh", "🏫", "Trường cũ và nhà phố", "phoco"],
    ["Đường Ngô Quyền", "🛵", "Bên kia sông, qua cầu Sông Hàn", "cauvong"],
    ["Đường Phạm Văn Đồng", "🏖️", "Ra bãi biển Phạm Văn Đồng", "bien"],
    ["Đường Hoàng Sa", "🐠", "Vòng bán đảo Sơn Trà", "dao"],
    ["Đường Võ Nguyên Giáp", "🏝️", "Mặt tiền biển Mỹ Khê", "bien"],
    ["Đường Trường Sa", "🌴", "Resort ven biển đi Hội An", "dao"],
    ["Đường Nguyễn Văn Thoại", "🍤", "Hải sản và quán đêm", "cho"],
    ["Đường Trần Phú", "⛪", "Nhà thờ Con Gà, phố cũ", "phoco"],
    ["Đường 2 Tháng 9", "🎡", "Công viên châu Á, Sun Wheel", "dothi"],
    ["Đường Yên Bái", "🏬", "Trung tâm thương mại Hải Châu", "dothi"],
    ["Đường Bạch Đằng", "🌉", "Bờ Tây sông Hàn, cầu Rồng", "cauvong"],
    ["Đường Trần Hưng Đạo", "🎆", "Bờ Đông, lễ hội pháo hoa", "songnuoc"],
  ]),
  transport: places([
    ["Sân bay Đà Nẵng", "✈️", "Sân bay trong lòng thành phố", "sanbay"],
    ["Ga Đà Nẵng", "🚉", "Đường sắt Bắc – Nam", "tauhoa"],
    ["Bến xe Trung tâm", "🚌", "Xe khách miền Trung", "duongpho"],
    ["Cảng Tiên Sa", "🛳️", "Cảng biển và tàu du lịch", "cangbien"],
  ]),
  utilities: places([
    ["Điện lực Đà Nẵng", "⚡", "Tiền thuê tính theo số xúc xắc", "dienluc"],
    ["Nước sạch Dawaco", "💧", "Tiền thuê tính theo số xúc xắc", "nuocsach"],
  ]),
});

/** Every board that ships, keyed by id. */
export const BUILTIN_MAPS = {
  vietnam: VIETNAM,
  hanoi: HANOI,
  hcmc: SAIGON,
  danang: DANANG,
};

/** @type {readonly string[]} */
export const BUILTIN_MAP_IDS = ["vietnam", "hanoi", "hcmc", "danang"];

export const DEFAULT_MAP_ID = "vietnam";

/** Just enough to draw the picker, without shipping four boards to do it. */
export function mapSummaries() {
  return BUILTIN_MAP_IDS.map((id) => {
    const m = BUILTIN_MAPS[id];
    return { id, name: m.name, icon: m.icon, region: m.region, note: m.note };
  });
}

/** The built-in board with this id, or the default one. */
export function builtinMap(id) {
  return BUILTIN_MAPS[id] ?? BUILTIN_MAPS[DEFAULT_MAP_ID];
}
