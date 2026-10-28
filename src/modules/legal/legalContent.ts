// PROSM Time Privacy Policy and Terms of Use (owner 2026-10-13). Written
// from what the app actually does - every data item, retention period and
// outside service below is taken from the code and the live configuration
// (see AUDIT_FIXES_REPORT.en.md). Arabic and English are the official
// versions; other app languages show the English text.
//
// When either text changes, raise LEGAL_VERSION: every user is asked to
// read and acknowledge the new version once (LegalAcknowledgementGate).
export const LEGAL_VERSION = "2026-10-28";

export interface LegalSection {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
}

export interface LegalDocument {
  title: string;
  updated: string;
  intro: string[];
  sections: LegalSection[];
}

export type LegalLanguage = "ar" | "en";

const PRIVACY_EN: LegalDocument = {
  title: "Privacy Policy",
  updated: "Last updated: 26 October 2026",
  intro: [
    "PROSM Time is an attendance, time and workforce-presence application provided by PROSM to organisations (\"the Organisation\") for their owners, managers, employees and site workers. This policy explains what personal data the application processes, why, who can see it, how long it is kept and what rights people have.",
    "PROSM Time records location and, where a site requires it, photos. We describe exactly when below. Please read it carefully.",
  ],
  sections: [
    {
      heading: "1. Who is responsible for your data",
      paragraphs: [
        "Your employer or the organisation that uses PROSM Time decides why and how the attendance data of its people is processed. It is the data controller for that data, and requests about it should be sent to it first.",
        "PROSM processes that data on the Organisation's behalf and on its instructions, as a service provider (processor). PROSM is responsible itself only for the data it needs to run the service: licensing, account security, support and the prosm.net website.",
        "Contact PROSM: info@prosm.net.",
      ],
    },
    {
      heading: "2. Who this policy applies to",
      bullets: [
        "Organisation owners and administrators who activate and manage an account.",
        "Managers, supervisors, employees and read-only users who sign in to the application.",
        "External workers (contractors, day labour) registered by the Organisation, who have no account in the app: the app gives each a 6-digit number, with which they clock in and out at a kiosk run by the Organisation's owner or a site manager.",
        "Where the Organisation turns it on, people who clock in on a shared kiosk device with a personal PIN.",
      ],
    },
    {
      heading: "3. The data we process",
      paragraphs: ["Depending on how the Organisation sets up the application, the following data may be processed:"],
      bullets: [
        "Account data: name, email address, role, organisation, sites you are assigned to, an optional profile picture, and your language and theme choices.",
        "Devices: for each phone or browser where you sign in, a random identifier the app creates on that device, its type and model name (for example \"Android - V2529\"), and when it was last used - to count the devices your Organisation's licence allows. It is removed when you sign out there, and no longer counts after 30 days unused.",
        "Attendance data: clock-in and clock-out times, breaks, site changes, the site or workplace name, optional notes and activity, and who recorded an action on someone's behalf. Times are recorded by the server's clock. For an action made without a connection, the device's time is kept and marked for a manager's review. A session still open after 24 hours is closed automatically and its hours wait for a manager's review before they count; permissions to arrive late or leave early, overtime approvals and manual adjustments to a day are kept with their reasons.",
        "Location data (GPS): your position and its accuracy at the moment you clock in, clock out, start or end a break, change site, or send an SOS alert. A shared kiosk also records it when a site worker clocks in or out. Whether you are inside the site's work area and the distance from it are also recorded.",
        "Location during a shift: only if the Organisation has turned on ongoing presence monitoring for the site, or when you clock in without a site. Your position is then recorded about every 5 minutes, only while you are clocked in, and it stops when you clock out. On Android this continues while the app is in the background or closed during your shift, and a notification stays visible the whole time. Where the site uses it, leaving the site's work area while clocked in asks you whether to clock out, or clocks you out automatically at the time you left; a manager can correct it.",
        "Simulated location: on Android, whether your device reports the location as coming from a mock-location (fake GPS) app.",
        "Photos: only when a site requires a photo at clock-in or clock-out, taken by you with the live camera at that moment (not chosen from the gallery). Where the phone supports it, a short live check on your device uses the phone's face detection only to see where a face is in the picture, and asks you to turn your head or move closer. The frames used for the check are not stored or sent; only the photo itself, which check was asked and its result are kept with it. A one-time code from the server is attached to each photo so that an old or reused photo can be recognised. PROSM Time does not identify people from their face and does not create biometric templates.",
        "Leave, allowances and timesheets: leave requests (type, dates, reason) and any document you attach to one (for example a medical certificate, visible only to you and those who review your leave), your hire date and, if the Organisation records it, a special-needs entitlement used only to count leave days, allowance entries and changes made to them during review, overtime, deductions for unpaid leave, timesheets and their approvals. Please do not include unnecessary health details in a leave reason.",
        "Exceptions and reviews: reasons you give for being outside a work area, correction requests, flags for a manager to look at (a live check that failed or could not run, an old or reused photo, a location that looks too exact or repeats exactly), and managers' decisions and notes.",
        "External worker data: name, contractor (if given), the 6-digit number the app generated, the site of each clock-in and clock-out, the times, the kiosk's location and, if the Organisation records it, the pay rate.",
        "Device and security data: a device identifier where the Organisation binds accounts to devices, the app installation and version, security and audit logs of important actions, and protection against repeated attempts, which stores only a scrambled (hashed) form of the network address.",
        "Data kept on your device: actions made without a connection are kept encrypted on your device until they are sent, then removed. The web version also keeps the app's own program files on the device (not your data), so that it can open without a connection.",
      ],
    },
    {
      heading: "4. Why we process it",
      bullets: [
        "To record attendance, working time, breaks and leave, and to prepare timesheets, allowances and payroll inputs for the Organisation.",
        "To confirm, according to the Organisation's settings, that attendance is recorded at or near the work site.",
        "For safety: to deliver SOS alerts with the location to the site's managers, the Organisation's owner and co-workers on site. For someone working without a chosen site, the managers of the nearest site receive it.",
        "To prevent misuse such as backdated times or fake locations. Flags of this kind are sent to a person for review. PROSM Time does not take decisions about people by itself.",
        "To keep the service secure, provide support, and meet legal obligations.",
      ],
      paragraphs: ["We do not sell personal data, we do not use it for advertising, and we do not track anyone outside their working time."],
    },
    {
      heading: "5. Legal basis",
      paragraphs: [
        "The Organisation is responsible for having a lawful basis for processing its people's data, for example the employment contract, legal obligations to keep working-time records, legitimate interests in security and fraud prevention, and protecting a person's vital interests in an emergency. Where the law requires consent, the Organisation must obtain it.",
        "Your device asks your permission for location, camera and notifications. You can withdraw these permissions in your device settings at any time. Some functions, such as recording attendance at a site that requires location or a photo, may then not be available.",
      ],
    },
    {
      heading: "6. Who can see your data",
      bullets: [
        "Within the Organisation, access depends on role. The owner can see the whole organisation. Managers and supervisors see, and act only for, the people at the sites they manage; a manager may pass some of their own permissions to a supervisor, and only the owner and managers approve leave or record attendance on someone's behalf (never their own). Employees see their own records. Exported report files are available to whoever made them and to the owner. Each organisation's data is separated from every other organisation's at the database level.",
        "PROSM staff, only when needed for support, security or maintenance, and under confidentiality.",
        "Service providers that host or deliver the service on PROSM's behalf:",
        "Supabase: database, file storage and server functions, hosted in the European Union (Frankfurt, Germany).",
        "Cloudflare: delivery of the web version through prosm.net.",
        "Google Firebase Cloud Messaging: delivers notifications to the Android app, including when it is closed. It receives a device token for your phone and each notification's title and text. The token is removed when you sign out.",
        "Map, place and weather services that the app contacts directly from your device: OpenStreetMap (map images for the area shown), BigDataCloud (a town name from your approximate position) and Open-Meteo (weather for that position).",
        "Email: invitations, password-reset codes, trial notices and leave emails are sent from noreply@prosm.net through PROSM's own email service (hosted by Zoho Mail). A leave email goes only between the person asking and the person who receives or answers the request, and contains their names and email addresses, the leave type, dates, days, reason, the decision with its note, and the remaining balance.",
        "Radio Browser: only if you play the internet radio. It receives the country your device's time zone points to, to suggest that country's stations; no personal data is sent.",
        "Google Maps: only if you tap a link to open a position on the map.",
        "Authorities, when PROSM or the Organisation is legally required to disclose data.",
      ],
    },
    {
      heading: "7. Transfers outside your country",
      paragraphs: [
        "The application's data is stored in the European Union. Map, place and weather requests, and the delivery of emails, may be handled by those providers in other countries. Where data is transferred internationally, we rely on safeguards recognised by applicable law.",
      ],
    },
    {
      heading: "8. How long data is kept",
      bullets: [
        "Location samples recorded during a shift: deleted automatically after 30 days.",
        "Attendance photos: deleted automatically after 90 days.",
        "Attendance records (including the location at clock-in and clock-out), timesheets, leave, allowances and their reviews: kept while the Organisation's account is active, for as long as the Organisation needs them and labour, tax or other laws require, unless the Organisation deletes them earlier.",
        "The Organisation can export or delete one person's data on request, except where the law requires it to be kept.",
        "If the Organisation's subscription or trial ends, its data is kept, not deleted, so that it can be reopened. It is deleted when the Organisation asks for that, or as agreed with PROSM.",
        "Security and audit logs: kept for as long as needed to protect the service and investigate incidents.",
      ],
    },
    {
      heading: "9. Security",
      paragraphs: [
        "Data is encrypted in transit. Access is controlled by role inside the database itself. Photos are kept in private storage and opened only through short-lived links. Kiosk PINs are hashed, actions waiting on your device are encrypted, important actions are logged, and a shared kiosk device is locked to its kiosk screen.",
        "No system is completely secure. If a breach affects personal data, the Organisation and the affected people, and the authorities where required, will be informed as the law requires.",
      ],
    },
    {
      heading: "10. Your rights",
      paragraphs: [
        "Depending on the law that applies to you, you may have the right to:",
      ],
      bullets: [
        "access your data and receive a copy of it;",
        "correct it;",
        "ask for it to be deleted or for its use to be restricted;",
        "object to some uses;",
        "receive it in a portable form;",
        "withdraw consent where processing relies on consent.",
      ],
    },
    {
      heading: "11. How to use your rights",
      paragraphs: [
        "Send your request first to your employer or organisation, which controls your data. PROSM helps it respond. You can also write to info@prosm.net.",
        "Deleting your account: in the app, open your user menu and choose \"Delete my account\" (your password is asked again). Your sign-in stops for good and your personal data is deleted at once - your name, email and picture, clock-in and clock-out photos, location trail, leave documents, devices and notifications. Your organisation keeps the work records that law and payroll require (attendance, timesheets, leave and allowances) without your name, as \"Deleted user\", for as long as section 8 says. The owner's account holds the organisation and is deleted on request to support@prosm.net.",
        "You may complain to the data protection authority in your country.",
      ],
    },
    {
      heading: "12. Age",
      paragraphs: ["PROSM Time is a workplace application for people of legal working age. It is not intended for children."],
    },
    {
      heading: "13. Changes to this policy",
      paragraphs: ["When this policy changes in a meaningful way, the application shows the new version and asks you to read it before you continue. The date at the top shows the current version."],
    },
    {
      heading: "14. Contact",
      paragraphs: ["PROSM: info@prosm.net · prosm.net"],
    },
  ],
};

const PRIVACY_AR: LegalDocument = {
  title: "سياسة الخصوصية",
  updated: "آخر تحديث: 26 أكتوبر 2026",
  intro: [
    "PROSM Time تطبيق لتسجيل الحضور ووقت العمل ومتابعة وجود العاملين، تقدّمه PROSM للمؤسسات («المؤسسة») لاستخدامه من مالكيها ومديريها وموظفيها وعمال مواقعها. توضّح هذه السياسة البيانات الشخصية التي يعالجها التطبيق، وسبب معالجتها، ومن يطّلع عليها، ومدة الاحتفاظ بها، والحقوق المكفولة لأصحابها.",
    "يسجّل PROSM Time الموقع الجغرافي، ويلتقط الصور حين يشترط الموقع ذلك، ونبيّن أدناه متى يحدث ذلك بالضبط. نرجو قراءتها بعناية.",
  ],
  sections: [
    {
      heading: "1. المسؤول عن بياناتك",
      paragraphs: [
        "جهة عملك أو المؤسسة التي تستخدم PROSM Time هي التي تقرر لماذا وكيف تُعالَج بيانات الحضور الخاصة بالعاملين لديها. فهي «المتحكم» في تلك البيانات، وتُوجَّه إليها الطلبات المتعلقة بها أولاً.",
        "تعالج PROSM تلك البيانات نيابةً عن المؤسسة ووفق تعليماتها بصفتها مقدّم خدمة («معالج»). وتكون PROSM مسؤولة بنفسها فقط عن البيانات اللازمة لتشغيل الخدمة: الترخيص، وأمان الحسابات، والدعم الفني، وموقع prosm.net.",
        "للتواصل مع PROSM: info@prosm.net.",
      ],
    },
    {
      heading: "2. من تنطبق عليهم هذه السياسة",
      bullets: [
        "مالكو المؤسسات والمسؤولون الذين يفعّلون الحساب ويديرونه.",
        "المديرون والمشرفون والموظفون ومستخدمو القراءة فقط الذين يسجّلون الدخول إلى التطبيق.",
        "العمالة الخارجية (المقاولون والعمالة اليومية) الذين تسجّلهم المؤسسة وليس لهم حساب في التطبيق: يولّد التطبيق لكل منهم رقماً من 6 أرقام، يسجّل به حضوره وانصرافه على كشك يشغّله مالك المؤسسة أو مدير الموقع.",
        "إذا فعّلت المؤسسة ذلك: من يسجّلون حضورهم على جهاز كشك مشترك برمز PIN شخصي.",
      ],
    },
    {
      heading: "3. البيانات التي نعالجها",
      paragraphs: ["بحسب إعدادات المؤسسة للتطبيق، قد تُعالَج البيانات التالية:"],
      bullets: [
        "بيانات الحساب: الاسم، والبريد الإلكتروني، والدور، والمؤسسة، والمواقع المعيَّن عليها، وصورة شخصية اختيارية، وتفضيلات اللغة والمظهر.",
        "الأجهزة: لكل هاتف أو متصفح تسجّل الدخول منه، معرّف عشوائي ينشئه التطبيق على ذلك الجهاز، ونوعه واسم طرازه (مثل \"Android - V2529\")، وآخر استخدام له - لعدّ الأجهزة التي يسمح بها ترخيص مؤسستك. ويُحذف عند تسجيل خروجك منه، ولا يُحسب بعد 30 يوماً دون استخدام.",
        "بيانات الحضور: أوقات الحضور والانصراف، والاستراحات، وتغيير الموقع، واسم الموقع أو مكان العمل، والملاحظات والنشاط الاختياريين، ومن سجّل إجراءً نيابةً عن غيره. تُسجَّل الأوقات بساعة الخادم. أما الإجراء الذي يتم دون اتصال، فيُحفظ وقته من الجهاز ويُعلَّم لمراجعة المدير. والجلسة التي تظل مفتوحة بعد 24 ساعة تُغلق تلقائياً وتنتظر ساعاتها مراجعة المدير قبل أن تُحتسب؛ وتُحفظ أذونات التأخير والانصراف المبكر، واعتمادات العمل الإضافي، والتعديلات اليدوية على اليوم مع أسبابها.",
        "بيانات الموقع (GPS): موقعك ودقته لحظة تسجيل الحضور أو الانصراف، أو بدء الاستراحة أو إنهائها، أو تغيير الموقع، أو إرسال تنبيه طوارئ SOS. ويسجّله جهاز الكشك المشترك أيضاً عند تسجيل حضور عامل الموقع أو انصرافه. ويُسجَّل كذلك ما إذا كنت داخل نطاق موقع العمل، ومدى بُعدك عنه.",
        "الموقع أثناء الوردية: فقط إذا فعّلت المؤسسة المتابعة المستمرة للتواجد في الموقع، أو إذا سجّلت حضورك دون موقع مسجّل. عندها يُسجَّل موقعك كل 5 دقائق تقريباً، وذلك فقط أثناء وجودك في الوردية، ويتوقف عند تسجيل الانصراف. وعلى أندرويد يستمر ذلك أثناء الوردية والتطبيق في الخلفية أو مغلق، مع إشعار ظاهر طوال الوقت. وحيث يستخدمه الموقع، فإن مغادرة نطاق العمل وأنت مسجّل حضور تسألك هل تسجّل الانصراف، أو تسجّل انصرافك تلقائياً بوقت مغادرتك؛ ويستطيع المدير تصحيح ذلك.",
        "الموقع المحاكى: على أندرويد، ما إذا كان جهازك يبلغ بأن الموقع صادر عن تطبيق موقع وهمي (GPS مزيف).",
        "الصور: فقط عندما يشترط الموقع صورة عند الحضور أو الانصراف، وتلتقطها أنت بالكاميرا المباشرة في تلك اللحظة (لا تُختار من المعرض). وحيث يدعم الهاتف ذلك، يستخدم تحقق حي قصير على جهازك خاصية اكتشاف الوجه في الهاتف فقط لمعرفة مكان الوجه في الصورة، ويطلب منك أن تلف رأسك أو تقترب. اللقطات المستخدمة في التحقق لا تُحفظ ولا تُرسل؛ ولا يُحفظ مع الصورة إلا الصورة نفسها ونوع التحقق المطلوب ونتيجته. ويُرفق بكل صورة رمز يُستخدم مرة واحدة من الخادم لتمييز الصورة القديمة أو المعاد استخدامها. ولا يتعرّف PROSM Time على الأشخاص من وجوههم، ولا يُنشئ أي بصمات حيوية (بيومترية).",
        "الإجازات والبدلات والكشوف: طلبات الإجازة (النوع، والتواريخ، والسبب) وأي مستند ترفقه بها (مثل شهادة طبية، ولا يطّلع عليه إلا أنت ومن يراجع إجازتك)، وتاريخ تعيينك، وإن سجّلته المؤسسة استحقاق ذوي الهمم الذي يُستخدم فقط لحساب أيام الإجازة، وإدخالات البدلات وما عُدّل فيها أثناء المراجعة، والعمل الإضافي، وخصومات الإجازة بدون أجر، والكشوف واعتماداتها. نرجو عدم ذكر تفاصيل صحية غير ضرورية في سبب الإجازة.",
        "الاستثناءات والمراجعات: الأسباب التي تقدّمها عند وجودك خارج نطاق العمل، وطلبات التصحيح، والتنبيهات التي يراجعها المدير (تحقق حي فشل أو تعذّر، أو صورة قديمة أو معاد استخدامها، أو موقع دقيق بشكل مريب أو متطابق تماماً)، وقرارات المديرين وملاحظاتهم.",
        "بيانات العمالة الخارجية: الاسم، والمقاول (إن ذُكر)، والرقم المكوّن من 6 أرقام الذي ولّده التطبيق، وموقع كل تسجيل حضور وانصراف، والأوقات، وموقع الكشك، والأجر إذا سجّلته المؤسسة.",
        "بيانات الجهاز والأمان: معرّف الجهاز إذا ربطت المؤسسة الحسابات بالأجهزة، وتثبيت التطبيق وإصداره، وسجلات الأمان والتدقيق للإجراءات المهمة، والحماية من المحاولات المتكررة، التي تحفظ عنوان الشبكة في صورة مجزّأة غير مقروءة فقط.",
        "البيانات المحفوظة على جهازك: الإجراءات التي تتم دون اتصال تُحفظ مشفّرة على جهازك إلى أن تُرسل، ثم تُحذف منه. وتحفظ نسخة الويب أيضاً ملفات البرنامج نفسه على الجهاز (لا بياناتك) حتى تفتح دون اتصال.",
      ],
    },
    {
      heading: "4. لماذا نعالجها",
      bullets: [
        "لتسجيل الحضور ووقت العمل والاستراحات والإجازات، وإعداد الكشوف والبدلات ومدخلات الرواتب للمؤسسة.",
        "للتأكد، وفق إعدادات المؤسسة، من أن الحضور يُسجَّل في موقع العمل أو بالقرب منه.",
        "للسلامة: لإيصال تنبيهات الطوارئ SOS مع الموقع إلى مديري الموقع ومالك المؤسسة والزملاء الموجودين في الموقع. ولمن يعمل دون اختيار موقع، يصل التنبيه إلى مديري أقرب موقع.",
        "لمنع إساءة الاستخدام، مثل تقديم الأوقات أو تزييف الموقع. تُرسل هذه التنبيهات لشخص يراجعها؛ فلا يتخذ PROSM Time قرارات بشأن الأشخاص من تلقاء نفسه.",
        "للحفاظ على أمان الخدمة، وتقديم الدعم، والوفاء بالالتزامات القانونية.",
      ],
      paragraphs: ["لا نبيع البيانات الشخصية، ولا نستخدمها للإعلانات، ولا نتتبع أحداً خارج وقت عمله."],
    },
    {
      heading: "5. الأساس القانوني",
      paragraphs: [
        "المؤسسة مسؤولة عن وجود أساس قانوني لمعالجة بيانات العاملين لديها. ومن أمثلة ذلك: عقد العمل، والالتزامات القانونية بحفظ سجلات وقت العمل، والمصلحة المشروعة في الأمان ومنع الاحتيال، وحماية المصالح الحيوية للشخص في حالات الطوارئ. وحيث يشترط القانون الموافقة، يجب على المؤسسة الحصول عليها.",
        "يطلب جهازك إذنك للوصول إلى الموقع والكاميرا والإشعارات، ويمكنك سحب هذه الأذونات من إعدادات جهازك في أي وقت. وقد لا تتاح عندها بعض الوظائف، مثل تسجيل الحضور في موقع يشترط الموقع الجغرافي أو الصورة.",
      ],
    },
    {
      heading: "6. من يطّلع على بياناتك",
      bullets: [
        "داخل المؤسسة، يتوقف الاطلاع على الدور. فالمالك يطّلع على المؤسسة كلها. والمديرون والمشرفون يطّلعون على من يعملون في المواقع التي يديرونها ويتصرفون لهم فقط؛ ويجوز للمدير أن يمنح المشرف بعض صلاحياته هو، ولا يوافق على الإجازات أو يسجّل الحضور بالنيابة عن أحد إلا المالك والمديرون (وليس لأنفسهم أبداً). والموظفون يطّلعون على سجلاتهم فقط. وملفات التقارير المُصدَّرة متاحة لمن أنشأها وللمالك. وبيانات كل مؤسسة معزولة عن بيانات أي مؤسسة أخرى على مستوى قاعدة البيانات.",
        "موظفو PROSM، فقط عند الحاجة للدعم أو الأمان أو الصيانة، مع الالتزام بالسرية.",
        "مقدّمو الخدمات الذين يستضيفون الخدمة أو يوصلونها نيابةً عن PROSM:",
        "Supabase: قاعدة البيانات وتخزين الملفات ووظائف الخادم، والاستضافة داخل الاتحاد الأوروبي (فرانكفورت، ألمانيا).",
        "Cloudflare: لتوصيل نسخة الويب عبر prosm.net.",
        "Google Firebase Cloud Messaging: لتوصيل الإشعارات إلى تطبيق أندرويد حتى وهو مغلق. ويتلقى رمزاً خاصاً بجهازك وعنوان كل إشعار ونصه. ويُحذف الرمز عند تسجيل خروجك.",
        "خدمات الخرائط والأماكن والطقس التي يتصل بها التطبيق مباشرةً من جهازك: OpenStreetMap (صور الخريطة للمنطقة المعروضة)، وBigDataCloud (اسم المدينة من موقعك التقريبي)، وOpen-Meteo (الطقس لذلك الموقع).",
        "البريد الإلكتروني: تُرسَل الدعوات وأكواد استعادة كلمة المرور وتنبيهات الفترة التجريبية ورسائل الإجازات من noreply@prosm.net عبر خدمة البريد الخاصة بـ PROSM (المستضافة لدى Zoho Mail). ورسالة الإجازة لا تتجاوز طالب الإجازة ومن يستلم الطلب أو يرد عليه، وتتضمن اسميهما وبريديهما ونوع الإجازة وتواريخها وعدد أيامها وسببها والقرار وملاحظته والرصيد المتبقي.",
        "Radio Browser: فقط إذا شغّلت الراديو عبر الإنترنت. ويتلقى الدولة التي تشير إليها المنطقة الزمنية لجهازك لاقتراح محطاتها، ولا تُرسل إليه أي بيانات شخصية.",
        "خرائط Google: فقط إذا ضغطت رابطاً لفتح موقع على الخريطة.",
        "الجهات الرسمية، عندما تُلزَم PROSM أو المؤسسة قانوناً بالإفصاح عن البيانات.",
      ],
    },
    {
      heading: "7. نقل البيانات خارج بلدك",
      paragraphs: [
        "تُخزَّن بيانات التطبيق داخل الاتحاد الأوروبي. وقد تعالج خدمات الخرائط والأماكن والطقس الطلبات، ويُوصَّل البريد الإلكتروني، في دول أخرى. وعند نقل البيانات دولياً نعتمد ضمانات يقرّها القانون المطبَّق.",
      ],
    },
    {
      heading: "8. مدة الاحتفاظ بالبيانات",
      bullets: [
        "نقاط الموقع المسجَّلة أثناء الوردية: تُحذف تلقائياً بعد 30 يوماً.",
        "صور الحضور: تُحذف تلقائياً بعد 90 يوماً.",
        "سجلات الحضور (ومنها الموقع عند الحضور والانصراف)، والكشوف، والإجازات، والبدلات ومراجعاتها: تُحفظ ما دام حساب المؤسسة قائماً، وطوال ما تحتاج إليه المؤسسة وتشترطه قوانين العمل أو الضرائب أو غيرها، ما لم تحذفها المؤسسة قبل ذلك.",
        "تستطيع المؤسسة تصدير بيانات شخص بعينه أو حذفها عند طلبه، إلا ما يُلزم القانون بحفظه.",
        "إذا انتهى اشتراك المؤسسة أو فترتها التجريبية، تُحفظ بياناتها ولا تُحذف كي يمكن إعادة فتحها. وتُحذف عندما تطلب المؤسسة ذلك، أو وفق ما يُتفق عليه مع PROSM.",
        "سجلات الأمان والتدقيق: تُحفظ طوال المدة اللازمة لحماية الخدمة والتحقيق في الحوادث.",
      ],
    },
    {
      heading: "9. الأمان",
      paragraphs: [
        "تُشفَّر البيانات أثناء انتقالها، ويُضبط الاطلاع حسب الدور داخل قاعدة البيانات نفسها. وتُحفظ الصور في تخزين خاص، ولا تُفتح إلا عبر روابط قصيرة الصلاحية. وتُخزَّن رموز PIN مجزّأة، وتُشفَّر الإجراءات المنتظرة على جهازك، وتُسجَّل الإجراءات المهمة، ويُقفل جهاز الكشك المشترك على شاشة الكشك.",
        "لا يوجد نظام آمن تماماً. وإذا وقع اختراق يمس البيانات الشخصية، تُبلَّغ المؤسسة والأشخاص المتأثرون، والجهات المختصة حيث يلزم، وفق ما يقتضيه القانون.",
      ],
    },
    {
      heading: "10. حقوقك",
      paragraphs: [
        "بحسب القانون المطبَّق عليك، قد يكون لك الحق في:",
      ],
      bullets: [
        "الاطلاع على بياناتك والحصول على نسخة منها؛",
        "تصحيحها؛",
        "طلب حذفها أو تقييد استخدامها؛",
        "الاعتراض على بعض أوجه استخدامها؛",
        "الحصول عليها بصيغة قابلة للنقل؛",
        "سحب موافقتك حين تقوم المعالجة على الموافقة.",
      ],
    },
    {
      heading: "11. كيفية ممارسة حقوقك",
      paragraphs: [
        "وجّه طلبك أولاً إلى جهة عملك أو المؤسسة المتحكمة في بياناتك، وتساعدها PROSM في الرد عليه. ويمكنك أيضاً مراسلة info@prosm.net.",
        "حذف حسابك: من قائمة المستخدم في التطبيق اختر «حذف حسابي» (تُطلب كلمة المرور مرة أخرى). فيتوقف دخولك نهائياً وتُحذف بياناتك الشخصية فوراً - اسمك وبريدك وصورتك، وصور الحضور والانصراف، ومسار موقعك، ومستندات الإجازات، والأجهزة والإشعارات. وتحتفظ مؤسستك بسجلات العمل التي يلزمها القانون والرواتب (الحضور والكشوف والإجازات والبدلات) دون اسمك، باسم «مستخدم محذوف»، للمدة المذكورة في البند 8. أما حساب صاحب الشركة فتتبعه المؤسسة كلها، ويُحذف بطلب إلى support@prosm.net.",
        "ويحق لك تقديم شكوى إلى جهة حماية البيانات في بلدك.",
      ],
    },
    {
      heading: "12. السن",
      paragraphs: ["PROSM Time تطبيق لبيئة العمل، موجَّه لمن بلغوا سن العمل القانونية، وليس مخصصاً للأطفال."],
    },
    {
      heading: "13. تعديل هذه السياسة",
      paragraphs: ["عندما تتغير هذه السياسة تغييراً جوهرياً، يعرض التطبيق النسخة الجديدة ويطلب منك قراءتها قبل المتابعة. ويوضح التاريخ في أعلاها النسخة السارية."],
    },
    {
      heading: "14. التواصل",
      paragraphs: ["PROSM: info@prosm.net · prosm.net"],
    },
  ],
};

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
        "These terms are governed by the laws of the Arab Republic of Egypt, and the courts of Cairo have jurisdiction, unless mandatory law where you live gives you other rights.",
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
        "تخضع هذه الشروط لقوانين جمهورية مصر العربية، وتختص محاكم القاهرة بنظر أي نزاع ينشأ عنها، ما لم تمنحك القوانين الآمرة في بلد إقامتك حقوقاً أخرى.",
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
  privacy: { en: PRIVACY_EN, ar: PRIVACY_AR },
  terms: { en: TERMS_EN, ar: TERMS_AR },
};

export function legalLanguage(appLanguage: string): LegalLanguage {
  return appLanguage === "ar" ? "ar" : "en";
}
