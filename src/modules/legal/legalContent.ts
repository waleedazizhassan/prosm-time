// PROSM Time Privacy Policy and Terms of Use (owner 2026-10-13). Written
// from what the app actually does - every data item, retention period and
// outside service below is taken from the code and the live configuration
// (see AUDIT_FIXES_REPORT.en.md). Arabic and English are the official
// versions; other app languages show the English text.
//
// When either text changes, raise LEGAL_VERSION: every user is asked to
// read and acknowledge the new version once (LegalAcknowledgementGate).
import { PRIVACY_V2_AR, PRIVACY_V2_EN } from "./privacyPolicyV2";

export const LEGAL_VERSION = "2026-10-31.2";

export type LegalBlock = { type: "paragraph"; text: string } | { type: "bullets"; items: string[] } | { type: "table"; head: string[]; rows: string[][] };

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  // The approved Privacy Policy mixes paragraphs, lists and tables, in order.
  blocks?: LegalBlock[];
}

export interface LegalDocument {
  title: string;
  updated: string;
  intro: string[];
  sections: LegalSection[];
}

export type LegalLanguage = "ar" | "en";

const TERMS_EN: LegalDocument = {
  title: "Terms of Use",
  updated: "Last updated: 26 October 2026",
  intro: [
    "These terms govern the use of PROSM Time, provided by PROSM. By activating an organisation account, signing in, or using a PROSM Time kiosk, you agree to them. The person who activates an account accepts these terms on behalf of the organisation (\"the Organisation\") and confirms that they have authority to do so.",
    "How personal data is handled is described in the Privacy Policy, which forms part of these terms.",
  ],
  sections: [
    {
      heading: "1. The service",
      paragraphs: [
        "PROSM Time records attendance, breaks, leave, timesheets, allowances and workforce presence. It also offers optional location checks at work sites, attendance photos, kiosk mode and SOS alerts.",
        "It is provided under a licence or a free trial. A trial lasts 30 days. When it ends, the Organisation's account is paused and its data is kept until a licence is activated.",
      ],
    },
    {
      heading: "2. Accounts and security",
      bullets: [
        "Keep your password and your kiosk PIN secret, and do not let anyone else use your account.",
        "You are responsible for actions made with your account.",
        "Tell your Organisation, or PROSM at info@prosm.net, without delay if you suspect unauthorised use.",
        "A shared kiosk device must be kept physically secure by the Organisation. Leaving kiosk mode requires the password of the account that opened it.",
      ],
    },
    {
      heading: "3. The Organisation's responsibilities",
      paragraphs: ["The Organisation decides how PROSM Time is used with its people. It is responsible for:"],
      bullets: [
        "having a lawful basis to record attendance, location and photos;",
        "telling its employees and workers clearly what is collected and why;",
        "obtaining consent where the law requires it;",
        "setting up work areas, photo requirements and ongoing presence monitoring in a way that is necessary, proportionate and lawful;",
        "not using PROSM Time to follow anyone outside their working time;",
        "handling its people's requests about their data, with PROSM's help;",
        "checking flags such as being outside a work area, a fake location or an offline time fairly, and letting the person explain before taking any action;",
        "complying with the labour, data-protection and other laws that apply to it.",
      ],
    },
    {
      heading: "4. Acceptable use",
      paragraphs: ["You must not:"],
      bullets: [
        "record false attendance in any way, including by faking your location, changing your device's clock, using someone else's PIN or account, or using a photo of someone else;",
        "attempt to access data you are not entitled to, or interfere with the service or its security;",
        "copy, reverse-engineer or resell the application, except as the law expressly allows;",
        "use the service for anything unlawful.",
      ],
    },
    {
      heading: "5. SOS alerts",
      paragraphs: [
        "The SOS button sends an alert with your location to your site's managers, the Organisation's owner and co-workers clocked in at the same site. If you work without a chosen site, the managers of the nearest site receive it.",
        "It is not an emergency service and does not contact the police, an ambulance or the fire service. In an emergency, always call your local emergency number.",
        "An alert needs an internet connection and a shift confirmed by the server, and its delivery cannot be guaranteed. Use SOS for real emergencies only.",
      ],
    },
    {
      heading: "6. Location, time and flags",
      paragraphs: [
        "GPS positions can be inaccurate, especially indoors. A time recorded without a connection comes from the device and is marked for review.",
        "Flags such as \"outside the work area\", \"fake location\", \"device time (offline)\" or a failed live check are information for a person to review, not decisions, and should not be used alone to discipline anyone.",
        "Where the Organisation turns them on, the application can close a session left open for 24 hours (its hours then wait for a manager's review) and clock a person out when they leave the site's work area. These are recorded and can be corrected by a manager; the Organisation remains responsible for the final working time and pay.",
      ],
    },
    {
      heading: "7. Data",
      paragraphs: [
        "The Organisation owns the data it and its people enter. It grants PROSM the right to process that data only to provide, secure and support the service, as described in the Privacy Policy.",
        "The Organisation can export its data and can ask for it to be deleted.",
      ],
    },
    {
      heading: "8. Availability and changes",
      paragraphs: [
        "We work to keep PROSM Time available and secure, but it is provided \"as is\" and may sometimes be unavailable, for example during maintenance. Clock in, clock out and breaks keep working without a connection and are sent when it returns.",
        "We may update the application to improve it or keep it secure.",
      ],
    },
    {
      heading: "9. Third-party services",
      paragraphs: [
        "Maps, place names and weather come from third-party services and are shown for convenience. They may be unavailable or inaccurate.",
      ],
    },
    {
      heading: "10. Suspension and termination",
      paragraphs: [
        "PROSM may suspend access that breaks these terms, puts the service or other users at risk, or is used unlawfully. Accounts may also be paused when a licence or trial ends.",
        "The Organisation may stop using the service at any time. What happens to its data then is described in the Privacy Policy.",
      ],
    },
    {
      heading: "11. Liability",
      paragraphs: [
        "To the extent permitted by law, PROSM is not liable for indirect or consequential loss, for decisions taken from the application's data (including payroll and disciplinary decisions), or for the outcome of an emergency.",
        "Nothing in these terms limits liability that cannot be limited by law.",
      ],
    },
    {
      heading: "12. The Organisation's indemnity",
      paragraphs: [
        "The Organisation is responsible for claims that arise from its unlawful use or configuration of PROSM Time, for example monitoring that the law does not allow.",
      ],
    },
    {
      heading: "13. Governing law",
      paragraphs: [
        "These terms are governed by the laws of the Arab Republic of Egypt, and the courts of Alexandria have jurisdiction, unless mandatory law where you live gives you other rights.",
      ],
    },
    {
      heading: "14. Changes and contact",
      paragraphs: [
        "When these terms change in a meaningful way, the application shows the new version and asks you to accept it before you continue.",
        "Questions: info@prosm.net · prosm.net",
      ],
    },
  ],
};

const TERMS_AR: LegalDocument = {
  title: "شروط الاستخدام",
  updated: "آخر تحديث: 26 أكتوبر 2026",
  intro: [
    "تنظّم هذه الشروط استخدام PROSM Time الذي تقدّمه PROSM. وبتفعيل حساب مؤسسة، أو تسجيل الدخول، أو استخدام كشك PROSM Time، فإنك توافق عليها. ومن يفعّل الحساب يقبل هذه الشروط نيابةً عن المؤسسة («المؤسسة»)، ويؤكد أنه مخوَّل بذلك.",
    "تُبيِّن سياسة الخصوصية طريقة التعامل مع البيانات الشخصية، وهي جزء من هذه الشروط.",
  ],
  sections: [
    {
      heading: "1. الخدمة",
      paragraphs: [
        "يسجّل PROSM Time الحضور والاستراحات والإجازات والكشوف والبدلات ووجود العاملين. ويقدّم أيضاً ميزات اختيارية: التحقق من الموقع في مواقع العمل، وصور الحضور، ووضع الكشك، وتنبيهات الطوارئ SOS.",
        "يُقدَّم بموجب ترخيص أو فترة تجريبية مجانية مدتها 30 يوماً. وعند انتهاء الفترة التجريبية يُوقف حساب المؤسسة مؤقتاً، وتُحفظ بياناتها إلى أن يُفعَّل ترخيص.",
      ],
    },
    {
      heading: "2. الحسابات والأمان",
      bullets: [
        "حافظ على سرية كلمة المرور ورمز PIN الخاص بالكشك، ولا تسمح لغيرك باستخدام حسابك.",
        "أنت مسؤول عن الإجراءات التي تتم بحسابك.",
        "أبلغ مؤسستك، أو PROSM على info@prosm.net، فوراً إذا اشتبهت في استخدام غير مصرّح به.",
        "على المؤسسة تأمين جهاز الكشك المشترك مادياً. ويتطلب الخروج من وضع الكشك كلمة مرور الحساب الذي فتحه.",
      ],
    },
    {
      heading: "3. مسؤوليات المؤسسة",
      paragraphs: ["تقرر المؤسسة طريقة استخدام PROSM Time مع العاملين لديها، وهي مسؤولة عن:"],
      bullets: [
        "وجود أساس قانوني لتسجيل الحضور والموقع والصور؛",
        "إبلاغ موظفيها وعمالها بوضوح بما يُجمع ولماذا؛",
        "الحصول على الموافقة حيث يشترطها القانون؛",
        "ضبط نطاقات العمل واشتراط الصور والمتابعة المستمرة للتواجد بقدر الضرورة والتناسب ووفق القانون؛",
        "عدم استخدام PROSM Time لتتبع أي شخص خارج وقت عمله؛",
        "التعامل مع طلبات العاملين لديها بشأن بياناتهم، بمساعدة PROSM؛",
        "مراجعة التنبيهات بإنصاف، مثل الوجود خارج نطاق العمل أو الموقع المزيف أو الوقت المسجَّل دون اتصال، وإتاحة الفرصة للشخص لتقديم تفسيره قبل اتخاذ أي إجراء؛",
        "الالتزام بقوانين العمل وحماية البيانات وغيرها من القوانين المطبَّقة عليها.",
      ],
    },
    {
      heading: "4. الاستخدام المقبول",
      paragraphs: ["لا يجوز لك:"],
      bullets: [
        "تسجيل حضور غير صحيح بأي طريقة، ومن ذلك تزييف موقعك، أو تغيير ساعة جهازك، أو استخدام رمز PIN أو حساب شخص آخر، أو استخدام صورة شخص آخر؛",
        "محاولة الوصول إلى بيانات لا يحق لك الاطلاع عليها، أو العبث بالخدمة أو بأمانها؛",
        "نسخ التطبيق، أو الهندسة العكسية له، أو إعادة بيعه، إلا في الحدود التي يجيزها القانون صراحةً؛",
        "استخدام الخدمة في أي غرض غير مشروع.",
      ],
    },
    {
      heading: "5. تنبيهات الطوارئ SOS",
      paragraphs: [
        "يرسل زر SOS تنبيهاً بموقعك إلى مديري موقعك، ومالك المؤسسة، والزملاء المسجَّل حضورهم في الموقع نفسه. وإذا كنت تعمل دون اختيار موقع، يصل التنبيه إلى مديري أقرب موقع.",
        "زر SOS ليس خدمة طوارئ، ولا يتصل بالشرطة أو الإسعاف أو الإطفاء. وفي حالات الطوارئ اتصل دائماً برقم الطوارئ المحلي.",
        "يحتاج التنبيه إلى اتصال بالإنترنت ووردية مؤكدة من الخادم، ولا يمكن ضمان وصوله. استخدم SOS في الطوارئ الحقيقية فقط.",
      ],
    },
    {
      heading: "6. الموقع والوقت والتنبيهات",
      paragraphs: [
        "قد لا تكون مواقع GPS دقيقة، خاصةً داخل المباني. والوقت المسجَّل دون اتصال مصدره الجهاز، ويُعلَّم للمراجعة.",
        "التنبيهات مثل «خارج نطاق العمل» أو «موقع مزيف» أو «وقت من الجهاز (أوفلاين)» أو فشل التحقق الحي معلومات يراجعها شخص، لا قرارات، ولا ينبغي الاعتماد عليها وحدها لمعاقبة أحد.",
        "حيث تفعّلها المؤسسة، يستطيع التطبيق إغلاق جلسة ظلت مفتوحة 24 ساعة (وتنتظر ساعاتها مراجعة المدير)، وتسجيل انصراف الشخص عند مغادرته نطاق عمل الموقع. ويُسجَّل ذلك ويستطيع المدير تصحيحه، وتظل المؤسسة مسؤولة عن وقت العمل والأجر النهائيين.",
      ],
    },
    {
      heading: "7. البيانات",
      paragraphs: [
        "تملك المؤسسة البيانات التي تُدخلها هي والعاملون لديها، وتمنح PROSM حق معالجتها فقط لتقديم الخدمة وتأمينها ودعمها، وفق ما تبيّنه سياسة الخصوصية.",
        "تستطيع المؤسسة تصدير بياناتها وطلب حذفها.",
      ],
    },
    {
      heading: "8. توفر الخدمة وتحديثها",
      paragraphs: [
        "نعمل على إبقاء PROSM Time متاحاً وآمناً، لكنه يُقدَّم «كما هو»، وقد يتعذر الوصول إليه أحياناً، كأثناء الصيانة. ويظل تسجيل الحضور والانصراف والاستراحات يعمل دون اتصال، ويُرسل عند عودته.",
        "قد نحدّث التطبيق لتحسينه أو للحفاظ على أمانه.",
      ],
    },
    {
      heading: "9. خدمات الأطراف الأخرى",
      paragraphs: [
        "تأتي الخرائط وأسماء الأماكن والطقس من خدمات أطراف أخرى، وتُعرض للتيسير، وقد تكون غير متاحة أو غير دقيقة.",
      ],
    },
    {
      heading: "10. الإيقاف والإنهاء",
      paragraphs: [
        "يجوز لـ PROSM إيقاف أي وصول يخالف هذه الشروط، أو يعرّض الخدمة أو المستخدمين الآخرين للخطر، أو يُستخدم استخداماً غير مشروع. وقد يُوقف الحساب مؤقتاً أيضاً عند انتهاء الترخيص أو الفترة التجريبية.",
        "يجوز للمؤسسة التوقف عن استخدام الخدمة في أي وقت، وتبيّن سياسة الخصوصية مصير بياناتها عندئذ.",
      ],
    },
    {
      heading: "11. المسؤولية",
      paragraphs: [
        "في الحدود التي يسمح بها القانون، لا تتحمل PROSM المسؤولية عن الخسائر غير المباشرة أو التبعية، ولا عن القرارات المتخذة بناءً على بيانات التطبيق (ومنها قرارات الرواتب والقرارات التأديبية)، ولا عن نتيجة أي حالة طوارئ.",
        "لا يحدّ أي شيء في هذه الشروط من المسؤولية التي لا يجوز قانوناً تحديدها.",
      ],
    },
    {
      heading: "12. تعويض المؤسسة",
      paragraphs: [
        "تتحمل المؤسسة المسؤولية عن المطالبات الناشئة عن استخدامها أو ضبطها لـ PROSM Time بشكل غير مشروع، كالمراقبة التي لا يجيزها القانون.",
      ],
    },
    {
      heading: "13. القانون الحاكم",
      paragraphs: [
        "تخضع هذه الشروط لقوانين جمهورية مصر العربية، وتختص محاكم الإسكندرية بنظر أي نزاع ينشأ عنها، ما لم تمنحك القوانين الآمرة في بلد إقامتك حقوقاً أخرى.",
      ],
    },
    {
      heading: "14. التعديلات والتواصل",
      paragraphs: [
        "عندما تتغير هذه الشروط تغييراً جوهرياً، يعرض التطبيق النسخة الجديدة ويطلب موافقتك قبل المتابعة.",
        "للاستفسارات: info@prosm.net · prosm.net",
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS: Record<"privacy" | "terms", Record<LegalLanguage, LegalDocument>> = {
  privacy: { en: PRIVACY_V2_EN, ar: PRIVACY_V2_AR },
  terms: { en: TERMS_EN, ar: TERMS_AR },
};

export function legalLanguage(appLanguage: string): LegalLanguage {
  return appLanguage === "ar" ? "ar" : "en";
}
