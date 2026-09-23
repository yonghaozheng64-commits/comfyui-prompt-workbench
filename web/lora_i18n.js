import { currentLocale } from './i18n.js';
const EXT = /\.(safetensors|ckpt|pt|bin|pth)$/i;

const TERMS = [
  ["multiple angles", "多角度"], ["multiple views", "多视角"], ["full body", "全身"],
  ["motion capture", "动作捕捉"], ["camera motion", "镜头运动"], ["high noise", "高噪声"],
  ["low noise", "低噪声"], ["lightning", "闪电加速"], ["fast", "快速"],
  ["detailer", "细节增强"], ["detailed eyes", "精细眼睛"], ["detailed", "精细"], ["detail", "细节增强"],
  ["real beauty", "真实美感"], ["realistic", "写实"], ["photorealistic", "照片写实"],
  ["cinematic", "电影感"], ["animation", "动画"], ["animate", "动画"],
  ["comic style", "漫画风格"], ["doujin style", "同人风格"], ["artist style", "画师风格"],
  ["style", "风格"], ["anime", "动漫"], ["illustrious", "Illustrious 模型"],
  ["pony", "Pony 模型"], ["flux", "Flux 模型"], ["qwen", "通义千问"],
  ["image edit", "图像编辑"], ["video", "视频"], ["image", "图像"],
  ["portrait", "肖像"], ["landscape", "风景"], ["character", "角色"],
  ["girl", "女性角色"], ["woman", "女性"], ["man", "男性"],
  ["face", "面部"], ["eyes", "眼睛"], ["hair", "头发"], ["clothes", "服装"],
  ["dress", "连衣裙"], ["tank top", "背心"], ["pose", "姿势"], ["dance", "舞蹈"],
  ["rotation", "旋转"], ["dynamic", "动态"], ["relight", "重新布光"],
  ["enhancer", "增强器"], ["ultimate", "终极"], ["fusion", "融合"],
  ["loss", "失败画面"], ["two panel", "双格漫画"], ["2koma", "双格漫画"],
  ["four steps", "四步加速"], ["8steps", "八步加速"], ["4steps", "四步加速"],
  ["i2v", "图生视频"], ["t2v", "文生视频"], ["inp", "修复"], ["low", "低"], ["high", "高"],
  ["sex", "成人姿势"], ["nsfw", "成人内容"], ["ntr", "NTR 题材"],
  ["food wars", "食戟之灵"], ["bleach", "死神"], ["persona", "女神异闻录"],
  ["overwatch", "守望先锋"], ["marvel rivals", "漫威争锋"], ["batman", "蝙蝠侠"],
  ["frieren", "芙莉莲"], ["fubuki", "吹雪"], ["tatsumaki", "龙卷"],
  ["asuna yuuki", "结城明日奈"], ["erina", "薙切绘里奈"], ["alice", "薙切爱丽丝"],
  ["yoshizawa kasumi", "芳泽霞"], ["takarada rikka", "宝多六花"], ["d.va", "D.Va"],
];

const EXPLICIT_TRANSLATIONS = {
  "360_epoch20": "360 度环绕旋转镜头",
  "animate/fastwan_t2v_14b_480p_lora_rank_128_bf16": "FastWan 14B 文生视频加速（480P）",
  "animate/wan2.2-fun-a14b-inp-low-hps2.1_resized_dynamic_avg_rank_15_bf16": "Wan 2.2 Fun 修复低噪声画质增强",
  "animate/wan2.2-lightning_i2v-a14b-4steps-lora_low_fp16": "Wan 2.2 图生视频四步闪电加速（低噪声）",
  "animate/wan21_pusav1_lora_14b_rank512_bf16": "Wan 2.1 PUSA 视频加速",
  "animate/wananimate_relight_lora_fp16": "WanAnimate 视频重新布光",
  "blacked_gangbang_-_andi_poses": "Andi 多人成人姿势合集",
  "bleach_basterbinebambietta_illuxl": "《死神》邦比爱塔·芭丝塔拜因",
  "bleach_dokugamineriruka_illuxl": "《死神》毒峰莉露卡",
  "bleach_orihimeinoue_illuxl": "《死神》井上织姬",
  "chinese style_20230608155715-000010": "中国风女侠风格",
  "chosenchinesestylensfw_v20": "精选中国武侠成人风格",
  "cooperative_fellatio": "双人协作口交姿势",
  "cunnystylev9.2-000022": "Cunny 动漫画风",
  "d.vaillulora": "《守望先锋》D.Va",
  "detailedeyes_v3": "精细眼睛增强 V3",
  "disney_animation_v5-v7": "迪士尼动画风格",
  "eddy/fulldynamic_ultimate_fusion_elite": "全动态终极融合动作增强",
  "eddy/wan22_mocap_fullbodycopy_ed": "Wan 2.2 全身动作捕捉复刻",
  "eddy/wan2.2-fun-a14b-inp-fusion-elite": "Wan 2.2 Fun 修复融合增强",
  "eddy/lightx2v_elite_it2v_animate_face": "LightX2V 面部动画增强",
  "erina_prodigy": "《食戟之灵》薙切绘里奈",
  "eroticdance": "Wan 女性性感舞蹈动作",
  "extreme-sex-v2.0-illustriousxlnoobai": "Illustrious 极端成人细节增强",
  "fategrandorderbabylonia_mashkyrielight_illuxl": "《FGO》玛修·基列莱特",
  "food wars - [girlpack] - version 1": "《食戟之灵》女性角色合集",
  "foodwarscomicstyle-000030": "《食戟之灵》漫画画风",
  "frieren_frieren_beyond_journeys_end_-_illustrious_v2": "《葬送的芙莉莲》芙莉莲",
  "fubuki": "《一拳超人》吹雪",
  "fulldynamic_ultimate_fusion_elite": "全动态终极融合动作增强",
  "gen(illust) 0.2v": "GEN 插画画风",
  "hyper-flux.1-dev-8steps-lora": "FLUX.1 Dev 八步加速",
  "instant_loss_2koma": "失败瞬间双格漫画",
  "jeannealterv1": "《Fate》黑贞德",
  "lora2komanoobaixlvpred": "NoobAI 双格漫画构图",
  "loose_tank_top": "宽松背心服装",
  "lunaxl": "Luna 女性角色",
  "marin_kitagawa_s1arisa_izayoi_cosplay_my_dress-up_darling": "《更衣人偶坠入爱河》喜多川海梦／十六夜亚里沙 Cos",
  "marvel_rivals_-_sue_storm_-_invisible_woman": "《漫威争锋》隐形女苏珊·斯通",
  "multiple_views_sex": "成人场景多视角构图",
  "ntr": "NTR 题材概念",
  "ntr_il_v1": "Illustrious NTR 题材概念",
  "nakirierinav10": "《食戟之灵》薙切绘里奈 V10",
  "overwatch_cinematic_illus_4_last-000008": "《守望先锋》电影动画画风",
  "phm_style_il_v2": "PHM Illustrious 插画风格包",
  "persona_5_royal_and_strikers_2d_cutscene_art_style_illustrious_v2": "《女神异闻录 5》二维过场动画画风",
  "queen_hiling-ranking_of_kings ix": "《国王排名》希琳王后",
  "qwen-anime-v1": "通义千问动漫画风",
  "qwen-edit-2509-multiple-angles": "通义千问图像编辑多角度生成",
  "qwen-image-edit-2509-lightning-8steps-v1.0-bf16": "通义千问图像编辑八步闪电加速（BF16）",
  "qwen-image-edit-2511-lightning-4steps-v1.0-bf16": "通义千问图像编辑四步闪电加速（BF16）",
  "qwen-image-edit-2511-lightning-4steps-v1.0-fp32": "通义千问图像编辑四步闪电加速（FP32）",
  "qwen-image-edit-f2p": "通义千问图像编辑 F2P 增强",
  "qwen-image-lightning-8steps-v1.1": "通义千问图像生成八步闪电加速",
  "real_beauty": "真实美感增强",
  "rider-il-v1-08": "《Fate/stay night》Rider／美杜莎",
  "sb_eve-il": "《剑星》伊芙 EVE",
  "t2v_14b_lownoise_v2 (1)": "14B 文生视频低噪声增强 V2（副本）",
  "t2v_14b_lownoise_v2": "14B 文生视频低噪声增强 V2",
  "takarada_rikka_illustrious": "《SSSS.古立特》宝多六花",
  "tatsumaki(manga)_ilxl_v1": "《一拳超人》漫画版龙卷",
  "tatsumakiil": "《一拳超人》龙卷",
  "trendcraft_the_peoples_style_detailer-v2.4i-5_18_2025-illustrious": "TrendCraft 大众画风细节增强",
  "usnr style_xl_lokr": "USNR XL 画师风格",
  "wan22_mocap_fullbodycopy_ed": "Wan 2.2 全身动作捕捉复刻",
  "wan2.2-fun-a14b-inp-high-noise-mps": "Wan 2.2 Fun 修复高噪声 MPS 增强",
  "wan2.2-fun-a14b-inp-low-noise-hps2.1": "Wan 2.2 Fun 修复低噪声画质增强",
  "xiao qing pony": "《白蛇》小青（Pony）",
  "yoshizawa kasumi": "《女神异闻录 5》芳泽霞",
  "[dc comics (alan moore brian bolland)] batman - the klling joke comic style illustrious": "DC《蝙蝠侠：致命玩笑》漫画画风",
  "[ratatatat74] bad ending party doujin style illustrious": "Ratatatat74《Bad Ending Party》同人画风",
  "acrobatic_sex": "杂技式多人成人姿势",
  "add-detail-xl": "SDXL 细节增强",
  "alice.v1.13": "《食戟之灵》薙切爱丽丝",
  "andrewcockroach_ill": "AndrewCockroach 画师风格",
  "asuna_yuuki_sao_s1~s2-ixl-anime-soralz": "《刀剑神域》结城明日奈",
  "bbbs": "BBBS 画师风格",
  "best_legs_up_pony": "九十度高抬腿姿势",
  "chinese-girl": "中国女性写实风格",
  "cofelpvlnccxlrd": "双女一男协作口交姿势（写实）",
  "color_splash": "黑白与彩色飞溅对比风格",
  "double_handgag": "双手捂嘴姿势",
  "faceless-ugly-man-illustriousxl-lora-nochekaiser": "无脸丑男／肥胖男性概念",
  "group_blowjob_v2": "多人群体口交姿势 V2",
  "gufeng1h_f1_rank2_bf16": "古风人物画风",
  "gyaru-style_girl": "辣妹 Gyaru 女性风格",
  "hanging legs": "双腿悬空姿势",
  "illustrious_very_aesthetic_v1": "Illustrious 高审美画质增强",
  "jack-o_challenge_pony": "Jack-O 挑战姿势",
  "jeanne_d'arc-000007": "《Fate》贞德",
  "konosuba_collection_v2": "《为美好的世界献上祝福！》角色合集 V2",
  "koreandolllikeness": "韩国人偶脸写实风格",
  "ksslnskxlrd": "跨种族情侣法式接吻（写实）",
  "lightx2v_i2v_14b_480p_cfg_step_distill_rank256_bf16": "LightX2V 14B 图生视频蒸馏加速（480P）",
  "lightx2v_elite_it2v_animate_face": "LightX2V 面部动画增强",
  "livewallpaper_wan22_14b_i2v_low_model_0_1_e26": "Wan 2.2 动态壁纸图生视频（低噪声）",
  "loose socks_illustrious_v1.0": "宽松堆堆袜服装（Illustrious）",
  "loose_socks": "宽松堆堆袜服装",
  "lou": "写实 3D CG 风格",
  "mating_press_v0.2-pony": "屈曲位成人姿势（Pony）",
  "ntr_noobai_v1.0": "NoobAI NTR 题材概念",
  "ntrface-wasabiya": "NTR 表情／Wasabiya 画风",
  "opm-fubuki-anime-s1s2-ponyxl-lora-nochekaiser": "《一拳超人》动画版吹雪",
  "penis_on_face": "男性生殖器贴脸姿势",
  "pixel_art_style_z_image_turbo": "Z-Image Turbo 像素艺术风格",
  "ponyv4_noob1_2_adamw-000017": "Pony／NoobAI 混合画风",
  "powergirlij2xl-12": "《不义联盟 2》神力女孩",
  "ratatatat74-000010": "Ratatatat74 画师风格",
  "ratatatat74-v2-000010": "Ratatatat74 画师风格 V2",
  "ratatatat74_style_ilxl_goofy": "Ratatatat74 Illustrious 画师风格",
  "rvcgmslnccxlrd": "跨种族多人成人场景（写实）",
  "sams/sam_vit_h_4b8939": "SAM ViT-H 图像分割模型",
  "sound_effects-000015": "视频音效生成增强",
  "spo_sdxl_10ep_4k-data_lora_webui": "SPO SDXL 偏好优化／画质增强",
  "stdbhjxlrd": "坐姿双手刺激成人姿势（写实）",
  "sxz-dcau-tomorrowverse-smol-pdxl": "DC 明日宇宙动画画风",
  "takahegao_fucked_silly_face_r1": "夸张失神成人表情",
  "wan2.2/sex animate/motion hance/st0m4chbulg3_fused_hn": "Wan 2.2 腹部隆起动作增强（高噪声）",
  "wan2.2/sex animate/sex hance/nsfw-22-h-e8": "Wan 2.2 通用成人动作增强（高噪声）",
  "wan2.2/sex animate/sex hance/nsfw-22-l-e8": "Wan 2.2 通用成人动作增强（低噪声）",
  "wan2.2/sex real/bettertitfuck_v4_july2025": "Wan 胸部性交动作增强 V4",
  "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise": "Wan 2.2 图生视频四步加速（高噪声）",
  "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise": "Wan 2.2 图生视频四步加速（低噪声）",
  "xiaohongshu-000004": "小红书女性穿搭摄影风格",
};

export function normalizeLoraKey(value) {
  return String(value || "").replaceAll("\\", "/").trim().toLowerCase().replace(EXT, "");
}

export function automaticChineseName(value) {
  const normalizedKey = normalizeLoraKey(value);
  if (EXPLICIT_TRANSLATIONS[normalizedKey]) return EXPLICIT_TRANSLATIONS[normalizedKey];
  const original = String(value || "").replaceAll("\\", "/");
  if (/^ai.*style.*illustrious.*goofy/i.test(normalizedKey)) return "Goofy AI 大叔插画风格";
  if (/qwennocl4ndsc4p3/i.test(normalizedKey)) return "通义千问自然风景生成";
  const base = original.split("/").pop().replace(EXT, "").replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ").replaceAll("-", " ");
  let translated = base;
  let changed = false;
  for (const [english, chinese] of TERMS) {
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`\\b${escaped}\\b`, "ig");
    if (pattern.test(translated)) {
      translated = translated.replace(pattern, chinese);
      changed = true;
    }
  }
  translated = translated.replace(/\s+/g, " ").trim();
  return changed ? translated : base;
}

export function translatedLoraName(value, aliases = {}) {
  const key = normalizeLoraKey(value);
  return String(aliases[key] || (currentLocale() === 'zh-CN' ? automaticChineseName(value) : value)).trim();
}

export function bilingualLoraName(value, aliases = {}) {
  const original = String(value || "").replaceAll("\\", "/").split("/").pop().replace(EXT, "");
  const chinese = translatedLoraName(value, aliases);
  return chinese && chinese.toLowerCase() !== original.toLowerCase() ? `${chinese} · ${original}` : original;
}

export function looksLikeLora(value) {
  return typeof value === "string" && EXT.test(value);
}
