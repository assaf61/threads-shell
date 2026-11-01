// רשימות-הדומים של בית עלמא (16/08/2026).
//
// עד היום שלוש רשימות-בחירה היו מקודדות בשלושה קבצים בקוד הזה, ובתוכן שמו המלא
// של הדום החתום. הריפו ציבורי: כל אדם יכול לפתוח את קוד-המקור ולקרוא אותו, גם
// כשהתוכן עצמו חתום ולא יוצא. שער-הביטחון של 15/08 פספס את זה כי הוא חיפש
// ערכי-נתונים (שמות, סכומים) ולא תוויות-מבנה - מפתחות-דומיין ושמות-קטגוריה.
//
// הרשימות חיות עכשיו ב-alma-paths.json, מפת-הנתיבים הקנונית של המכונה, שהכלל
// הכתוב בה הוא "מקור-אמת יחיד; רכיב שמקודד נתיב מיושר אליו בהזדמנות הקרובה".
// הקובץ מאחורי ההזדהות, ולכן השמות נקראים רק אחרי כניסה.
//
// ברירת-המחדל כאן היא מה שמותר להיות ציבורי. היא אינה גיבוי מלא במכוון: אם
// המפה לא נטענה, הדום החתום פשוט אינו מוצע. עדיף שיעד-ניתוב יהיה חסר מאשר
// ששמו יהיה כתוב בקוד ציבורי, וזו הסיבה שהאפליקציה טוענת לפני שהיא מציעה.

import { CONFIG } from "./config.js";
import { getDrivePathText } from "./graph.js";

// מה שמותר בקוד ציבורי: הדומים שאין בשמם מידע.
const FALLBACK = {
  capture_domes: [["alma-r", "עלמא · פרטי"], ["alma-public", "ציבורי · עתידי"], ["alma-threads", "השאר ב-inbox"]],
  threads_vaults: [["alma-r", "עלמא · פרטי (כאן אני עובד)"], ["alma-public", "הדום הציבורי · עתידי"], ["alma-threads", "השאר ב-inbox"]],
  questions_vaults: [["", "ללא ניתוב · רק נקה"], ["alma-r", "Alma.R (פרטי)"], ["alma-r-proj", "Alma.R · בנייה"],
    ["alma-health", "Alma.R · בריאות"], ["alma-invest", "Alma.R · השקעות"], ["alma-finance", "Alma.R · כספים"],
    ["alma-daily", "Alma.R · יומיומי"], ["alma-research", "Alma.R · מחקר"]],
  questions_dirs: {
    "alma-r": "Alma.R", "alma-r-proj": "Alma.R · בנייה", "alma-health": "Alma.R · בריאות",
    "alma-invest": "Alma.R · השקעות", "alma-finance": "Alma.R · כספים", "alma-daily": "Alma.R · יומיומי",
    "alma-research": "Alma.R · מחקר",
  },
};

let cache = null;      // מה שנטען בפועל, או null עד שנטען
let inflight = null;   // כדי ששלושה משטחים שנפתחים יחד לא ימשכו שלוש פעמים

// זוגות [slug,label] בלבד. קובץ שנערך ביד יכול להחזיר כל דבר, ורשימת-בחירה
// שנבנית מזבל שוברת את המשטח - אז מסננים ולא סומכים.
function pairs(v) {
  return Array.isArray(v)
    ? v.filter((x) => Array.isArray(x) && x.length >= 2 && typeof x[0] === "string" && typeof x[1] === "string")
       .map((x) => [x[0], x[1]])
    : null;
}
function strMap(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out = {};
  Object.keys(v).forEach((k) => { if (typeof v[k] === "string") out[k] = v[k]; });
  return Object.keys(out).length ? out : null;
}

// נטען פעם אחת לסשן. כישלון אינו זורק: המשטח עולה עם ברירת-המחדל המצומצמת.
export async function primeDomains(token) {
  if (cache || !token) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const raw = await getDrivePathText(token, CONFIG.pathsPath);
      const ui = raw ? (JSON.parse(raw).ui_pickers || {}) : {};
      cache = {
        capture_domes: pairs(ui.capture_domes) || FALLBACK.capture_domes,
        threads_vaults: pairs(ui.threads_vaults) || FALLBACK.threads_vaults,
        questions_vaults: pairs(ui.questions_vaults) || FALLBACK.questions_vaults,
        questions_dirs: strMap(ui.questions_dirs) || FALLBACK.questions_dirs,
      };
    } catch { cache = null; }
    inflight = null;
    return cache;
  })();
  return inflight;
}

// סינכרוני בכוונה: הרנדור לא ממתין. מי שרוצה את הרשימה המלאה קורא primeDomains
// פעם אחת בכניסה, וזה מה ש-app.js עושה.
export function domains() { return cache || FALLBACK; }
