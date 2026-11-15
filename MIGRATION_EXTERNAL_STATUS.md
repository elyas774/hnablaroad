# فحوص الوجهات الخارجية — 15 نوفمبر 2026

## Supabase

المشروع المستهدف الذي أعاده موصل Supabase: `hanabila`، المعرّف `ssvrzhjefvqjrdpfvmhh`، الرابط: <https://supabase.com/dashboard/project/ssvrzhjefvqjrdpfvmhh>.

- فحص `list_migrations` بعد العمل أكد الترحيلات `005_student_attendance_cas` إلى `012_student_excuses`.
- فحص SQL للترحيل `012` أكد: RLS مفعّلة على `student_excuse_requests`؛ لا توجد امتيازات `SELECT` مباشرة لـ`anon` أو`authenticated` أو`service_role` على الجدول؛ دالة `student_excuses_action` هي `SECURITY DEFINER`، وامتياز `EXECUTE` متاح لـ`service_role` فقط، مع `search_path` ثابت.
- مستشار الأمن سجّل ملاحظة معلوماتية عن RLS المفعّلة دون سياسات على جداول خاصة (سلوك منع افتراضي متعمد مع غياب امتيازات الوصول المباشر)، وتحذيرًا بأن حماية كلمات المرور المسرّبة في Auth متوقفة. توضح وثائق Supabase أن هذه الحماية تتطلب Pro أو أعلى وإعداد Auth عبر لوحة المشروع: <https://supabase.com/docs/guides/auth/password-security>.
- لا يتضمن تطبيق migrations تعديلًا مباشرًا لصفوف الطلاب؛ لا يوجد اختبار end-to-end عبر واجهة الويب في هذه الجولة.

## Netlify والمستودع

- قراءات Netlify السابقة أظهرت موقعين متشابهين: `the-hanabila-road1` و`the-hanabila-road-3`. لم يتحدد أيهما staging المقصود، لذلك لم تُعدّل إعداداتهما ولم يُنشر عليهما.
- المستودع: <https://github.com/elyas774/hnablaroad>، الفرع المحلي `migration/supabase-auth`. لم يحدث commit أو push إلى `main`، ولا نشر Netlify؛ النسخة الحية لم تتغير.
- متغيرات Supabase اللازمة للوظائف لم تُضف إلى Netlify بعد؛ يجب ضبطها على staging المؤكد فقط، مع بقاء `SUPABASE_SERVICE_ROLE_KEY` ضمن نطاق Functions.

## التحقق المحلي

- اجتازت مجموعة الاختبارات المحلية 138 اختبارًا بلا إخفاق، إضافة إلى فحوص الصياغة و`git diff --check`.
- سجلات Firebase التاريخية لتغذية التطبيق بقيت للقراءة فقط؛ ما زال يلزم تدقيق ملفات Firebase القديمة وFCM قبل اعتبار إزالة Firebase من كل أنواع التخزين مكتملة.
