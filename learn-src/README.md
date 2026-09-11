# מערכת הלמידה — מקור

הקוד של מערכת הלמידה. הקובץ שנפרס לאתר, `learn.html`, נבנה מכאן.

## בנייה

```bash
node build-learn.mjs      # מהשורש של הריפו
```

מייצר `learn.html` — קובץ אחד עם כל ה-CSS, ה-JS והאייקונים בפנים.
`ms-config.js` נשאר קובץ נפרד בכוונה, כדי שאפשר יהיה לשנות את הגדרות
ההתחברות בלי לבנות מחדש.

| קובץ | תפקיד |
| --- | --- |
| `styles.css` | הטוקנים של Nocturne, שכבת הרכיבים ומסך ההתחברות |
| `icons.js` | 66 אייקוני Phosphor מוטמעים כ-SVG |
| `app.js` | מודל המצב, 23 המסכים והניתוב |
| `auth.js` | מסך ההתחברות ל-Microsoft |
| `vendor/msal-browser.min.js` | ספריית ההתחברות הרשמית של Microsoft (MSAL 5) |

---

## הגדרת ההתחברות ל-Microsoft 365

ההתחברות היא לחשבון Microsoft 365 של המכון — אותו חשבון של Teams והמייל.
צריך רישום אפליקציה חד-פעמי ב-Microsoft Entra ID. מי שמבצע: מנהל ה-IT
של המכון (נדרשות הרשאות Application Administrator ומעלה).

### 1. יצירת רישום אפליקציה

1. כניסה ל-[portal.azure.com](https://portal.azure.com) → **Microsoft Entra ID** → **App registrations** → **New registration**.
2. **Name**: `מכון פוירשטיין — מערכת הלמידה`
3. **Supported account types**: *Accounts in this organizational directory only (Single tenant)* — כך רק חשבונות של המכון יוכלו להיכנס.
4. **Redirect URI**: לבחור **Single-page application (SPA)** — חשוב, לא Web — ולהזין את הכתובת של דף הלמידה:

   ```
   https://<הכתובת-של-האתר>/learn.html
   ```

   אם עובדים גם מקומית, אפשר להוסיף שם גם `http://localhost:8080/learn.html`.
5. **Register**.

### 2. העתקת המזהים

בעמוד **Overview** של הרישום מופיעים:

- **Application (client) ID**
- **Directory (tenant) ID**

### 3. מילוי הקובץ

לערוך את `ms-config.js` בשורש הריפו:

```js
window.MS_AUTH_CONFIG = {
  clientId: '11111111-2222-3333-4444-555555555555',
  tenantId: '99999999-8888-7777-6666-555555555555',
  redirectUri: ''
};
```

לשמור, לדחוף ל-`main` — הפריסה אוטומטית, ומסך ההתחברות יעבור מיד ממצב
דמו להתחברות אמיתית.

### הרשאות

הרישום מבקש רק את ההרשאה `User.Read` — קריאת הפרופיל של המשתמש המחובר
(שם ומייל). זו הרשאה שמשתמש מאשר לעצמו; ברוב הארגונים לא נדרש אישור
מנהל. אם במכון חסומה הסכמת משתמשים, יש ללחוץ **Grant admin consent**
במסך **API permissions**.

### פרטיות

הסיסמה לא עוברת דרך המערכת אף פעם — ההתחברות מתבצעת מול השרתים של
Microsoft, והמערכת מקבלת בחזרה רק שם ומייל. אין כאן ניהול סיסמאות
נפרד, ולכן גם אין מה לדלוף.

### בדיקה

1. לפתוח את `learn.html` באתר.
2. ללחוץ **התחברות עם חשבון המכון** — נפתח מסך ההתחברות של Microsoft.
3. אחרי ההתחברות חוזרים לדף הלמידה, והשם מהחשבון מופיע בכותרת ובתיק.
4. יציאה: תפריט המשתמש בפינה → **יציאה**.

**תקלה נפוצה:** `AADSTS9002326` או שגיאת redirect — הכתובת ב-Entra ID
נרשמה כ-**Web** ולא כ-**Single-page application**. יש למחוק ולהוסיף
מחדש תחת SPA.

---

## אחסון בשרת (learning-gateway)

מרגע שההתחברות ל-Microsoft פעילה, המערכת שומרת את הנתונים של כל לומד בשרת
(Supabase), מבודדים לפי הזהות המאומתת שלו — לא רק ב-localStorage.

- **הקוד בקליינט מחובר** (`app.js` + `auth.js`): בכניסה עם חשבון Microsoft הוא
  טוען את המצב מהשרת, וכל שינוי נשמר לשרת (debounced) עם ה-localStorage כמטמון
  לא-מקוון. **הכניסה הזמנית (דמו) נשארת מקומית בלבד** — שכבת השרת כבויה בלעדיה.
- **הצד השרתי:** הפונקציה `supabase/functions/learning-gateway` והמיגרציה
  `supabase/migrations/20260909_learning_tables.sql`. הבידוד per-user מאומת ב-
  `learning-gateway/verify.reference.test.mjs` (22 בדיקות).

כדי להפעיל את האחסון בשרת (אחרי רישום Entra ID לעיל):
1. secrets בפרויקט Supabase: `MS_TENANT_ID` ו-`MS_CLIENT_ID` (אותם מזהים מ-`ms-config.js`).
2. להריץ את המיגרציה: `supabase db push` (או הדבקת ה-SQL ב-SQL Editor).
3. לפרוס את הפונקציה: `supabase functions deploy learning-gateway`.

עד שהשלבים האלה בוצעו, הכל ממשיך לעבוד מקומית (מטמון), והסנכרון פשוט מדלג בשקט.

---

## התחברות אימייל + סיסמה (עם אישור מנהל)

חלופה ל-Microsoft: הרשמה עצמית עם אימייל וסיסמה, כאשר כל חשבון חדש **ממתין לאישור**
של מנהל המערכת. פעיל כש-`ms-config.js` ריק (אין Microsoft). הסיסמאות נבדקות רק
בשרת (`learn-auth`), מגובבות ב-PBKDF2, ואף פעם לא בדפדפן.

- **שדות הרשמה:** שם מלא, תפקיד, אימייל (`@icelp.org.il`), ת"ז (עם בדיקת ספרת ביקורת),
  סיסמה, אימות סיסמה.
- **מנהל המערכת:** מי שנרשם עם הכתובת שהוגדרה ב-`LEARN_ADMIN_EMAIL` — מאושר אוטומטית,
  והיחיד שמאשר/דוחה אחרים. הכתובת הזו פטורה מכלל `@icelp.org.il`.
- **התראה:** כשמנהל המערכת מחובר, כפתור צף "אישור הרשמות" עם מונה מציג את ההרשמות
  הממתינות ונפתח מעצמו כשיש חדשות (התראה בתוך האפליקציה). דחיפה לנייד — ראה למטה.

### הפעלה ב-Supabase

1. **secrets** (Project Settings → Edge Functions → Secrets):
   - `LEARN_TOKEN_SECRET` — מחרוזת אקראית לחתימת הטוקנים. אפשר להשתמש בזו:
     ```
     Upr5k0F9wT1BdxIU75G6lURUpnVnJdsdrjbBmW2zRVfGOWiOJJ_xiTa6uXXFWutg
     ```
   - `LEARN_ADMIN_EMAIL` — כתובת מנהל המערכת (למשל `Matanz@ice.org.il`).
2. **מיגרציה:** להריץ `supabase/migrations/20260911_learning_accounts.sql` (או `supabase db push`).
3. **פריסה:** `supabase functions deploy learn-auth`.
4. **מיזוג ל-main** (רק אחרי 1–3): הכניסה עוברת מדמו להרשמה/התחברות אמיתית.

### דחיפה לנייד (Push) — שלב הבא

התשתית קיימת (טבלת `learning_push` + פעולת `registerPush`), אבל שליחת ה-Push בפועל
(מפתחות VAPID + פרוטוקול Web Push + service worker ל-learn) עדיין לא מומשה. ההתראה
בתוך האפליקציה עובדת מלאה; דחיפת ה-Push היא הרחבה נפרדת.
