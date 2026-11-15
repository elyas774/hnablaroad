-- Server-authoritative weekly challenges, answer validation, Ayat submissions and rewards.
-- The fixed question bank is copied from the existing client catalog so scoring no longer
-- depends on a client-supplied answer key. Student text/logs and answer rows remain private.
begin;

create table if not exists public.student_challenge_questions (
  station_order smallint not null check (station_order between 0 and 5),
  station_id text not null check (station_id in ('aqeedah','fiqh','hadith','tafsir','seerah','usul')),
  question_index smallint not null check (question_index between 0 and 4),
  question_text text not null check (length(question_text) between 1 and 1000),
  options jsonb not null check (jsonb_typeof(options)='array' and jsonb_array_length(options)=4),
  correct_index smallint not null check (correct_index between 0 and 3),
  explanation text not null check (length(explanation) between 1 and 1000),
  primary key (station_order, question_index),
  unique (station_id, question_index)
);

insert into public.student_challenge_questions(station_order,station_id,question_index,question_text,options,correct_index,explanation) values
(0,'aqeedah',0,'من مؤلف متن "ثلاثة الأصول" الذي يدرسه طريق الحنابلة؟','["محمد بن عبدالوهاب","ابن تيمية","ابن كثير","ابن عثيمين"]',0,'المتن لمحمد بن عبدالوهاب رحمه الله، وشرحه لابن عثيمين.'),
(0,'aqeedah',1,'ما هي أقسام التوحيد الثلاثة؟','["الربوبية، والألوهية، والأسماء والصفات","الصلاة، والزكاة، والصوم","الإيمان، والإسلام، والإحسان","القرآن، والسنة، والإجماع"]',0,'أقسام التوحيد ثلاثة كما قرر أهل العلم.'),
(0,'aqeedah',2,'ما هو ضد التوحيد؟','["الشرك","النفاق","الكفر بالنعمة","الغفلة"]',0,'الشرك هو صرف العبادة لغير الله، وهو ضد التوحيد.'),
(0,'aqeedah',3,'"الولاء والبراء" يعني؟','["الحب والموالاة فيما يرضي الله، والبغض فيما يغضبه","حب الوطن","الولاء للحاكم فقط","معاداة كل غير مسلم"]',0,'هو أصل عقدي يقوم على الحب والبغض في الله.'),
(0,'aqeedah',4,'كم عدد أركان الإيمان؟','["ستة","خمسة","أربعة","ثلاثة"]',0,'أركان الإيمان ستة: الإيمان بالله، وملائكته، وكتبه، ورسله، واليوم الآخر، والقدر.'),
(1,'fiqh',0,'كم عدد الأحكام التكليفية؟','["خمسة","ثلاثة","أربعة","سبعة"]',0,'الواجب، والمستحب، والمباح، والمكروه، والمحرم.'),
(1,'fiqh',1,'كتاب "زاد المستقنع" من تأليف؟','["الحجاوي","ابن قدامة","البهوتي","ابن عثيمين"]',0,'ألفه شرف الدين الحجاوي، وهو مختصر متداول في الفقه الحنبلي.'),
(1,'fiqh',2,'الطهارة في اصطلاح الفقهاء تعني؟','["رفع الحدث وإزالة النجس","غسل اليدين فقط","الوضوء وحده","الاغتسال يوم الجمعة"]',0,'وهي شرط لصحة الصلاة.'),
(1,'fiqh',3,'كم عدد أركان الإسلام؟','["خمسة","ستة","أربعة","ثلاثة"]',0,'الشهادتان، والصلاة، والزكاة، والصوم، والحج.'),
(1,'fiqh',4,'القياس في أصول الفقه هو؟','["إلحاق فرع بأصل لعلة جامعة بينهما","حفظ النصوص","تفسير القرآن بالرأي","ترتيب الأحاديث"]',0,'من أدلة الأحكام المتفق على اعتبارها عند كثير من الفقهاء.'),
(2,'hadith',0,'الحديث الذي اتصل سنده بنقل عدل ضابط عن مثله من غير شذوذ ولا علة يسمى؟','["الصحيح","الضعيف","الموضوع","المرسل"]',0,'هذا هو تعريف الحديث الصحيح عند المحدثين.'),
(2,'hadith',1,'"السند" هو؟','["سلسلة الرواة الناقلين للحديث","نص الحديث نفسه","عنوان الكتاب","اسم المؤلف"]',0,'أما نص الحديث فيسمى "المتن".'),
(2,'hadith',2,'"المتن" هو؟','["نص الحديث ذاته","سلسلة الرواة","اسم الراوي الأول","تاريخ الرواية"]',0,'يقابله السند وهو سلسلة الرواة.'),
(2,'hadith',3,'الحديث الذي رواه عدد كبير يستحيل تواطؤهم على الكذب يسمى؟','["متواتر","آحاد","حسن","غريب"]',0,'وهو أعلى درجات الثبوت.'),
(2,'hadith',4,'كتاب "نخبة الفكر" من تأليف؟','["ابن حجر العسقلاني","ابن كثير","الذهبي","النووي"]',0,'من أهم المختصرات في علم مصطلح الحديث.'),
(3,'tafsir',0,'تفسير ابن كثير يعتمد أساساً على منهج؟','["التفسير بالمأثور","التفسير بالرأي المحض","التفسير الإشاري","التفسير اللغوي فقط"]',0,'يفسر القرآن بالقرآن، ثم بالسنة، ثم بأقوال الصحابة.'),
(3,'tafsir',1,'الآيات التي نزلت قبل الهجرة النبوية تسمى؟','["مكية","مدنية","منسوخة","متشابهة"]',0,'وما نزل بعد الهجرة يسمى مدنياً.'),
(3,'tafsir',2,'"أسباب النزول" تعني؟','["الأحداث التي نزلت الآية بسببها","ترتيب نزول السور","عدد آيات السورة","أسماء رواة القراءات"]',0,'تُعين على فهم سياق الآية ومعناها.'),
(3,'tafsir',3,'كتاب "تيسير الكريم الرحمن" من تأليف؟','["عبدالرحمن السعدي","الطبري","القرطبي","ابن كثير"]',0,'من أشهر التفاسير الميسرة المعاصرة.'),
(3,'tafsir',4,'"الناسخ والمنسوخ" مصطلح يتعلق بـ؟','["حكم يرد بعده حكم آخر يزيل العمل بالأول","ترتيب السور في المصحف","عدد القراءات","أسباب النزول"]',0,'من موضوعات علوم القرآن المهمة.'),
(4,'seerah',0,'كتاب "الرحيق المختوم" من تأليف؟','["صفي الرحمن المباركفوري","ابن هشام","ابن كثير","الذهبي"]',0,'من أشهر كتب السيرة المعاصرة، وحاز جائزة رابطة العالم الإسلامي.'),
(4,'seerah',1,'أين ابتدأ نزول الوحي على النبي ﷺ؟','["غار حراء","غار ثور","المسجد الحرام","المدينة المنورة"]',0,'وذلك في حادثة المبعث النبوي.'),
(4,'seerah',2,'"حجة الوداع" وقعت في العام؟','["العاشر للهجرة","الأول للهجرة","الثاني للهجرة","الخامس للهجرة"]',0,'وهي حجة النبي ﷺ الوحيدة.'),
(4,'seerah',3,'كتاب "زاد المعاد" من تأليف؟','["ابن القيم الجوزية","ابن تيمية","ابن كثير","الذهبي"]',0,'من أوسع كتب السيرة والفقه المرتبط بها.'),
(4,'seerah',4,'أي الغزوات وقعت في السنة الثانية للهجرة وكانت أول غزوة كبرى؟','["بدر","أحد","الخندق","حنين"]',0,'كانت فارقة في تاريخ الدعوة الإسلامية.'),
(5,'usul',0,'كتاب "الآجرومية" يُعنى بعلم؟','["النحو","الفقه","الحديث","التفسير"]',0,'من أشهر المتون المختصرة في النحو العربي.'),
(5,'usul',1,'كتاب "الورقات" في أصول الفقه يُنسب إلى؟','["إمام الحرمين الجويني","الشافعي","ابن قدامة","الغزالي"]',0,'من أشهر المختصرات المدروسة في أصول الفقه.'),
(5,'usul',2,'"العام" في أصول الفقه يقابله؟','["الخاص","المطلق","المقيد","الناسخ"]',0,'العام: لفظ يستغرق جميع أفراده، والخاص بخلافه.'),
(5,'usul',3,'الإعراب في اللغة العربية هو؟','["تغيّر أواخر الكلمات بحسب موقعها في الجملة","ترتيب الكلمات في الجملة","حفظ المفردات","نطق الحروف"]',0,'من أساسيات علم النحو.'),
(5,'usul',4,'صيغة "الأمر" تقتضي عند جمهور الأصوليين؟','["الوجوب ما لم تصرفه قرينة","التحريم دائماً","الإباحة دائماً","الكراهة"]',0,'هذا هو الأصل عند أكثر الأصوليين.')
on conflict (station_order,question_index) do nothing;

create table if not exists public.student_challenge_guess_cards (
  card_index smallint primary key check (card_index between 0 and 3),
  category text not null,
  icon text not null,
  prompt text not null,
  accepted_answers jsonb not null check (jsonb_typeof(accepted_answers)='array' and jsonb_array_length(accepted_answers)>0),
  points integer not null check (points between 1 and 100)
);
insert into public.student_challenge_guess_cards(card_index,category,icon,prompt,accepted_answers,points) values
(0,'صورة','🕌','مكان مبارك: ما هذا المكان؟','["المسجد النبوي","المدينة","المدينة المنورة","المسجد النبوي الشريف"]',15),
(1,'صوت قارئ','🎙️','قارئ مشهور: من صاحب الصوت؟ (تجربة تخمينية)','["عبدالباسط","عبد الباسط","عبدالباسط عبدالصمد","عبد الباسط عبد الصمد"]',20),
(2,'رمز','🌙','خمن الرمز: ماذا يمثل؟','["الهلال","القمر","شهر رمضان","رمضان"]',10),
(3,'صورة','📚','ما الشيء الظاهر في التحدي؟','["كتاب","الكتاب","علم"]',10)
on conflict (card_index) do nothing;

create table if not exists public.student_challenge_wheel_prizes (
  slot_index smallint primary key check (slot_index between 0 and 24),
  prize_type text not null check (prize_type in ('points','ticket','retry','none')),
  amount integer not null default 0 check (amount between 0 and 300),
  label text not null,
  icon text not null
);
insert into public.student_challenge_wheel_prizes(slot_index,prize_type,amount,label,icon) values
(0,'points',5,'5 نقاط','🪙'),(1,'points',10,'10 نقاط','⭐'),(2,'points',15,'15 نقطة','✨'),(3,'points',20,'20 نقطة','💰'),(4,'points',25,'25 نقطة','🏅'),
(5,'points',30,'30 نقطة','🎯'),(6,'points',40,'40 نقطة','💎'),(7,'points',50,'50 نقطة','🏆'),(8,'points',60,'60 نقطة','🌟'),(9,'points',75,'75 نقطة','👑'),
(10,'points',100,'100 نقطة','🔥'),(11,'ticket',1,'تذكرة إضافية','🎟️'),(12,'ticket',2,'تذكرتان إضافيتان','🎟️'),(13,'ticket',5,'5 تذاكر إضافية','🎟️'),(14,'points',125,'125 نقطة','🚀'),
(15,'points',150,'150 نقطة','🌙'),(16,'points',200,'200 نقطة','☀️'),(17,'points',300,'300 نقطة','🕌'),(18,'points',35,'35 نقطة','📚'),(19,'points',45,'45 نقطة','🤲'),
(20,'retry',0,'أعد المحاولة','🔁'),(21,'retry',0,'أعد المحاولة','🔁'),(22,'none',0,'بدون جائزة','🫥'),(23,'none',0,'بدون جائزة','🫥'),(24,'none',0,'بدون جائزة','🫥')
on conflict (slot_index) do nothing;

create table if not exists public.student_challenge_weekly_answers (
  week_key text not null check (week_key ~ '^\d{4}-W\d{2}$'),
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  choice_index smallint not null check (choice_index between 0 and 3),
  is_correct boolean not null,
  points_awarded integer not null check (points_awarded in (0,8)),
  submitted_at timestamptz not null default now(),
  primary key (week_key, owner_legacy_id)
);

create table if not exists public.student_challenge_submissions (
  submission_id uuid primary key,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  submission_text text not null check (length(submission_text) between 1 and 500),
  date_key date not null,
  approved boolean not null default false,
  submitted_at timestamptz not null default now()
);
create index if not exists student_challenge_submissions_day on public.student_challenge_submissions(date_key, submitted_at desc);
create index if not exists student_challenge_submissions_owner on public.student_challenge_submissions(owner_legacy_id, submitted_at desc);

-- Preserve unlimited daily participation while granting at most one ticket per verified student/day.
create table if not exists public.student_challenge_ticket_awards (
  owner_auth_user_id uuid not null,
  owner_legacy_id text not null,
  date_key date not null,
  awarded_at timestamptz not null default now(),
  primary key (owner_auth_user_id, date_key)
);

create table if not exists public.student_challenge_games (
  game_id uuid primary key,
  owner_legacy_id text not null,
  owner_auth_user_id uuid not null,
  game_type text not null check (game_type in ('guess','wheel')),
  item_index smallint not null,
  finished boolean not null default false,
  result jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists student_challenge_games_owner on public.student_challenge_games(owner_legacy_id, created_at desc);

create table if not exists public.student_challenge_events (
  event_id bigint generated always as identity primary key,
  owner_legacy_id text not null,
  event_text text not null check (length(event_text) between 1 and 500),
  icon text not null check (length(icon) between 1 and 16),
  created_at timestamptz not null default now()
);
create index if not exists student_challenge_events_owner_recent on public.student_challenge_events(owner_legacy_id, created_at desc);

create table if not exists public.student_challenge_winner_awards (
  date_key date primary key,
  winner_legacy_id text not null,
  awarded_by_legacy_id text not null,
  points_awarded integer not null default 25 check (points_awarded=25),
  awarded_at timestamptz not null default now()
);

alter table public.student_challenge_questions enable row level security;
alter table public.student_challenge_guess_cards enable row level security;
alter table public.student_challenge_wheel_prizes enable row level security;
alter table public.student_challenge_weekly_answers enable row level security;
alter table public.student_challenge_submissions enable row level security;
alter table public.student_challenge_ticket_awards enable row level security;
alter table public.student_challenge_games enable row level security;
alter table public.student_challenge_events enable row level security;
alter table public.student_challenge_winner_awards enable row level security;
revoke all on table public.student_challenge_questions, public.student_challenge_guess_cards,
  public.student_challenge_wheel_prizes, public.student_challenge_weekly_answers,
  public.student_challenge_submissions, public.student_challenge_ticket_awards, public.student_challenge_games,
  public.student_challenge_events, public.student_challenge_winner_awards
  from public, anon, authenticated, service_role;

create or replace function public.student_challenges_action(
  p_auth_user_id uuid,
  p_op text,
  p_choice_index integer,
  p_text text,
  p_submission_id uuid,
  p_game_id uuid,
  p_answer text
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_actor text;
  v_actor_name text;
  v_leader_raw text;
  v_leader text;
  v_is_leader boolean := false;
  v_week text;
  v_week_hash numeric := 0;
  v_week_index integer;
  v_i integer;
  v_question public.student_challenge_questions%rowtype;
  v_correct boolean;
  v_has_answer boolean := false;
  v_duplicate boolean := false;
  v_date date := (now() at time zone 'Asia/Riyadh')::date;
  v_submitted_at timestamptz;
  v_today_submission_count integer := 0;
  v_user_target text;
  v_target_name text;
  v_point_delta integer := 0;
  v_ticket_delta integer := 0;
  v_event_text text;
  v_event_icon text := '🎟️';
  v_users_version bigint;
  v_users_raw text;
  v_users jsonb;
  v_user jsonb;
  v_user_next jsonb;
  v_users_next jsonb;
  v_user_matches integer;
  v_points numeric;
  v_total_points numeric;
  v_tickets numeric;
  v_row jsonb;
  v_answer_row public.student_challenge_weekly_answers%rowtype;
  v_submission public.student_challenge_submissions%rowtype;
  v_submission_id uuid;
  v_winner text;
  v_winner_count integer;
  v_award_count integer;
  v_game public.student_challenge_games%rowtype;
  v_card public.student_challenge_guess_cards%rowtype;
  v_prize public.student_challenge_wheel_prizes%rowtype;
  v_answer_norm text;
  v_alias text;
  v_found boolean := false;
  v_result jsonb;
  v_items jsonb;
  v_item jsonb;
  v_data jsonb;
begin
  if p_auth_user_id is null or p_op not in ('state','logs','weekly_answer','ayat_submit','leader_submissions','ayat_award_winner','guess_start','guess_answer','wheel_spin') then
    raise exception 'Invalid challenge operation';
  end if;
  select u.legacy_id, coalesce(nullif(u.display_name,''),u.username)
    into v_actor,v_actor_name
    from public.app_users u
   where u.auth_user_id=p_auth_user_id and u.needs_password_reset=false;
  if v_actor is null then raise exception 'Account not linked or password reset required'; end if;

  select s.data->>'value' into v_leader_raw from public.shared s where s.id='weekLeaderId' for share;
  if v_leader_raw is not null then
    begin v_leader := v_leader_raw::jsonb #>> '{}'; exception when others then v_leader := v_leader_raw; end;
  end if;
  v_is_leader := coalesce(v_leader=v_actor,false);
  if p_op in ('leader_submissions','ayat_award_winner') and not v_is_leader then
    return jsonb_build_object('ok',false,'forbidden',true);
  end if;

  -- Lock and validate the actor's canonical profile before creating any durable record.
  -- The same lock is retained through the eventual balance update below.
  if p_op not in ('state','logs','leader_submissions') then
    select s.version,s.data->>'value' into v_users_version,v_users_raw from public.shared s where s.id='users' for update;
    if not found or v_users_raw is null then raise exception 'User state unavailable'; end if;
    begin v_users:=v_users_raw::jsonb; exception when others then raise exception 'User state malformed'; end;
    if jsonb_typeof(v_users)<>'array' then raise exception 'User state malformed'; end if;
    select count(*) into v_user_matches from jsonb_array_elements(v_users) e(user_row) where e.user_row->>'id'=v_actor;
    if v_user_matches<>1 then raise exception 'Actor state unavailable'; end if;
    select e.user_row into v_user from jsonb_array_elements(v_users) e(user_row) where e.user_row->>'id'=v_actor limit 1;
    begin v_tickets:=coalesce(nullif(v_user->>'challengeTickets','')::numeric,0); exception when others then v_tickets:=0; end;
  end if;

  -- The legacy client uses local ISO week dates. Riyadh time is the deployed course's
  -- intended local calendar; the key itself and question selection are computed here.
  v_week := to_char(now() at time zone 'Asia/Riyadh','IYYY') || '-W' || to_char(now() at time zone 'Asia/Riyadh','IW');
  for v_i in 1..length(v_week) loop
    v_week_hash := mod(v_week_hash*31 + ascii(substr(v_week,v_i,1)),4294967296);
  end loop;
  v_week_index := mod(v_week_hash,30)::integer;
  select q.* into v_question from public.student_challenge_questions q
   order by q.station_order,q.question_index offset v_week_index limit 1;
  if not found then raise exception 'Challenge catalog unavailable'; end if;

  if p_op='state' then
    select s.data->>'value' into v_users_raw from public.shared s where s.id='users' for share;
    begin v_users:=v_users_raw::jsonb; exception when others then v_users:='[]'::jsonb; end;
    select count(*) into v_user_matches from jsonb_array_elements(case when jsonb_typeof(v_users)='array' then v_users else '[]'::jsonb end) e(user_row) where e.user_row->>'id'=v_actor;
    if v_user_matches<>1 then raise exception 'User state unavailable'; end if;
    select e.user_row into v_user from jsonb_array_elements(v_users) e(user_row) where e.user_row->>'id'=v_actor limit 1;
    select a.* into v_answer_row from public.student_challenge_weekly_answers a where a.week_key=v_week and a.owner_legacy_id=v_actor;
    v_has_answer:=found;
    select coalesce(jsonb_agg(e.item order by e.created_at desc),'[]'::jsonb) into v_items from (
      select e.created_at,jsonb_build_object('text',e.event_text,'icon',e.icon,'date',to_char(e.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) item
        from public.student_challenge_events e where e.owner_legacy_id=v_actor order by e.created_at desc limit 20
    ) e;
    select count(*) into v_today_submission_count from public.student_challenge_submissions s
      where s.owner_legacy_id=v_actor and s.date_key=v_date;
    select * into v_submission from public.student_challenge_submissions s
      where s.owner_legacy_id=v_actor and s.date_key=v_date order by s.submitted_at desc limit 1;
    if found then
      v_item:=jsonb_build_object('id',v_submission.submission_id,'userId',v_submission.owner_legacy_id,
        'text',v_submission.submission_text,'dateKey',v_submission.date_key,
        'date',v_submission.submitted_at,'approved',v_submission.approved);
    else
      v_item:=null;
    end if;
    v_data:=jsonb_build_object(
      'weekKey',v_week,
      'weekly',jsonb_build_object('question',v_question.question_text,'options',v_question.options,'answered',v_has_answer,
        'correct',case when v_has_answer then v_answer_row.is_correct else null end,
        'explanation',case when v_has_answer then v_question.explanation else null end),
      'challengeTickets',greatest(0,coalesce(nullif(v_user->>'challengeTickets','')::numeric,0)),
      'logs',v_items,'ayatSubmission',v_item,'ayatSubmissionCount',v_today_submission_count
    );
    return jsonb_build_object('ok',true,'data',v_data);
  end if;

  if p_op='logs' then
    select coalesce(jsonb_agg(e.item order by e.created_at desc),'[]'::jsonb) into v_items from (
      select x.created_at,jsonb_build_object('text',x.event_text,'icon',x.icon,'date',to_char(x.created_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) item
        from public.student_challenge_events x where x.owner_legacy_id=v_actor order by x.created_at desc limit 20
    ) e;
    return jsonb_build_object('ok',true,'data',jsonb_build_object('logs',v_items));
  end if;

  if p_op='leader_submissions' then
    select s.data->>'value' into v_users_raw from public.shared s where s.id='users' for share;
    begin v_users:=v_users_raw::jsonb; exception when others then v_users:='[]'::jsonb; end;
    select coalesce(jsonb_agg(q.item order by q.submitted_at desc),'[]'::jsonb) into v_items from (
      select x.submitted_at,jsonb_build_object('id',x.submission_id,'userId',x.owner_legacy_id,
        'userName',coalesce((select e.user_row->>'name' from jsonb_array_elements(case when jsonb_typeof(v_users)='array' then v_users else '[]'::jsonb end) e(user_row) where e.user_row->>'id'=x.owner_legacy_id limit 1),x.owner_legacy_id),
        'text',x.submission_text,'dateKey',x.date_key,'date',to_char(x.submitted_at,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'approved',x.approved) item
      from public.student_challenge_submissions x where x.date_key=v_date order by x.submitted_at desc limit 200
    ) q;
    return jsonb_build_object('ok',true,'data',jsonb_build_object('submissions',v_items,'dateKey',v_date));
  end if;

  if p_op='weekly_answer' then
    if p_choice_index is null or p_choice_index not between 0 and 3 then raise exception 'Invalid answer choice'; end if;
    insert into public.student_challenge_weekly_answers(week_key,owner_legacy_id,owner_auth_user_id,choice_index,is_correct,points_awarded)
    values(v_week,v_actor,p_auth_user_id,p_choice_index,p_choice_index=v_question.correct_index,case when p_choice_index=v_question.correct_index then 8 else 0 end)
    on conflict(week_key,owner_legacy_id) do nothing;
    get diagnostics v_award_count=row_count;
    if v_award_count=0 then
      select a.* into v_answer_row from public.student_challenge_weekly_answers a where a.week_key=v_week and a.owner_legacy_id=v_actor;
      return jsonb_build_object('ok',true,'data',jsonb_build_object('alreadyAnswered',true,'correct',v_answer_row.is_correct,'points',v_answer_row.points_awarded));
    end if;
    v_correct:=p_choice_index=v_question.correct_index;
    if v_correct then
      v_user_target:=v_actor; v_point_delta:=8; v_event_text:='فاز بتحدي الأسبوع وحصل على 8 نقطة إضافية 🔥'; v_event_icon:='🔥';
    end if;
    v_data:=jsonb_build_object('alreadyAnswered',false,'correct',v_correct,'points',case when v_correct then 8 else 0 end,'explanation',v_question.explanation);
  elsif p_op='ayat_submit' then
    if p_text is null or length(btrim(p_text)) not between 1 and 500 or translate(p_text,E'\n\r\t','') ~ '[[:cntrl:]]' then raise exception 'Invalid submission'; end if;
    v_submission_id:=coalesce(p_submission_id,gen_random_uuid());
    insert into public.student_challenge_submissions(submission_id,owner_legacy_id,owner_auth_user_id,submission_text,date_key)
    values(v_submission_id,v_actor,p_auth_user_id,left(btrim(p_text),500),v_date) on conflict(submission_id) do nothing;
    get diagnostics v_award_count=row_count;
    if v_award_count=0 then
      if not exists(select 1 from public.student_challenge_submissions x where x.submission_id=v_submission_id and x.owner_legacy_id=v_actor) then return jsonb_build_object('ok',false,'conflict',true); end if;
      return jsonb_build_object('ok',true,'data',jsonb_build_object('alreadySubmitted',true));
    end if;
    insert into public.student_challenge_ticket_awards(owner_auth_user_id,owner_legacy_id,date_key)
    values(p_auth_user_id,v_actor,v_date) on conflict(owner_auth_user_id,date_key) do nothing;
    get diagnostics v_award_count=row_count;
    if v_award_count=1 then
      v_user_target:=v_actor; v_ticket_delta:=1;
      v_event_text:='حصلت على تذكرة: المشاركة في يوم الآيات'; v_event_icon:='🎟️';
    end if;
    v_data:=jsonb_build_object('submissionId',v_submission_id,'dateKey',v_date,'submitted',true,'ticketAwarded',v_award_count=1,
      'ticketBalance',case when v_award_count=1 then v_tickets+1 else v_tickets end);
  elsif p_op='ayat_award_winner' then
    if exists(select 1 from public.student_challenge_winner_awards a where a.date_key=v_date) then
      return jsonb_build_object('ok',false,'conflict',true);
    end if;
    select x.owner_legacy_id,count(*) into v_winner,v_winner_count
      from public.student_challenge_submissions x where x.date_key=v_date
     group by x.owner_legacy_id order by count(*) desc,max(x.submitted_at) desc limit 1;
    if v_winner is null then return jsonb_build_object('ok',false,'conflict',true); end if;
    select count(*) into v_user_matches from jsonb_array_elements(v_users) e(user_row) where e.user_row->>'id'=v_winner;
    if v_user_matches<>1 then return jsonb_build_object('ok',false,'conflict',true); end if;
    insert into public.student_challenge_winner_awards(date_key,winner_legacy_id,awarded_by_legacy_id)
      values(v_date,v_winner,v_actor) on conflict(date_key) do nothing;
    get diagnostics v_award_count=row_count;
    if v_award_count<>1 then return jsonb_build_object('ok',false,'conflict',true); end if;
    update public.student_challenge_submissions set approved=true where date_key=v_date and owner_legacy_id=v_winner;
    v_user_target:=v_winner; v_point_delta:=25; v_event_text:='تم منحك 25 نقطة لفوزك بيوم الآيات'; v_event_icon:='🏆';
    v_data:=jsonb_build_object('winnerId',v_winner,'submissions',v_winner_count,'points',25);
  elsif p_op='guess_start' then
    if p_game_id is null then raise exception 'Invalid game identifier'; end if;
    select floor(random()*4)::smallint into v_i;
    insert into public.student_challenge_games(game_id,owner_legacy_id,owner_auth_user_id,game_type,item_index)
      values(p_game_id,v_actor,p_auth_user_id,'guess',v_i) on conflict(game_id) do nothing;
    if not found then
      select g.* into v_game from public.student_challenge_games g where g.game_id=p_game_id and g.owner_legacy_id=v_actor and g.game_type='guess';
      if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
      v_i:=v_game.item_index;
    end if;
    select c.* into v_card from public.student_challenge_guess_cards c where c.card_index=v_i;
    return jsonb_build_object('ok',true,'data',jsonb_build_object('gameId',p_game_id,'kind',v_card.category,'icon',v_card.icon,'prompt',v_card.prompt));
  elsif p_op='guess_answer' then
    if p_game_id is null or p_answer is null or length(btrim(p_answer)) not between 1 and 120 then raise exception 'Invalid game answer'; end if;
    select g.* into v_game from public.student_challenge_games g where g.game_id=p_game_id and g.owner_legacy_id=v_actor and g.game_type='guess' for update;
    if not found then return jsonb_build_object('ok',false,'notFound',true); end if;
    if v_game.finished then return jsonb_build_object('ok',true,'data',coalesce(v_game.result,'{}'::jsonb)||jsonb_build_object('alreadyAnswered',true)); end if;
    if v_tickets<1 then return jsonb_build_object('ok',false,'conflict',true); end if;
    select c.* into v_card from public.student_challenge_guess_cards c where c.card_index=v_game.item_index;
    v_answer_norm:=lower(btrim(p_answer));
    select exists(select 1 from jsonb_array_elements_text(v_card.accepted_answers) a(value)
      where position(lower(a.value) in v_answer_norm)>0 or position(v_answer_norm in lower(a.value))>0) into v_correct;
    v_user_target:=v_actor; v_ticket_delta:=-1;
    if v_correct then v_point_delta:=v_card.points; v_event_text:='فاز في التخمينات وحصل على '||v_card.points||' نقطة'; v_event_icon:='🎯';
    else v_event_text:='استخدم تذكرة في التخمينات ولم يصب الإجابة'; v_event_icon:='🎯'; end if;
    v_data:=jsonb_build_object('gameId',p_game_id,'correct',v_correct,'points',case when v_correct then v_card.points else 0 end);
    update public.student_challenge_games set finished=true,result=v_data,finished_at=now() where game_id=p_game_id;
  elsif p_op='wheel_spin' then
    if p_game_id is null then raise exception 'Invalid game identifier'; end if;
    if v_tickets<1 then return jsonb_build_object('ok',false,'conflict',true); end if;
    select floor(random()*25)::smallint into v_i;
    insert into public.student_challenge_games(game_id,owner_legacy_id,owner_auth_user_id,game_type,item_index)
      values(p_game_id,v_actor,p_auth_user_id,'wheel',v_i) on conflict(game_id) do nothing;
    if not found then
      select g.* into v_game from public.student_challenge_games g where g.game_id=p_game_id and g.owner_legacy_id=v_actor and g.game_type='wheel';
      if not found then return jsonb_build_object('ok',false,'conflict',true); end if;
      if v_game.finished then return jsonb_build_object('ok',true,'data',coalesce(v_game.result,'{}'::jsonb)||jsonb_build_object('alreadyPlayed',true)); end if;
      v_i:=v_game.item_index;
    end if;
    select p.* into v_prize from public.student_challenge_wheel_prizes p where p.slot_index=v_i;
    if v_prize.prize_type='points' then v_point_delta:=v_prize.amount;
    elsif v_prize.prize_type='ticket' then v_ticket_delta:=v_prize.amount;
    else v_ticket_delta:=0; end if;
    v_ticket_delta:=v_ticket_delta-1;
    if v_prize.prize_type='points' then v_event_text:='مبروك! '||v_prize.label||' 🎉';
    elsif v_prize.prize_type='ticket' then v_event_text:='مبروك! '||v_prize.label||' 🎟️';
    elsif v_prize.prize_type='retry' then v_event_text:='أعد المحاولة في دورة أخرى 🔁';
    else v_event_text:='لم تحصل على جائزة هذه المرة 🫥'; end if;
    v_event_icon:=v_prize.icon;
    v_data:=jsonb_build_object('gameId',p_game_id,'type',v_prize.prize_type,'amount',v_prize.amount,'label',v_prize.label,'icon',v_prize.icon);
    update public.student_challenge_games set finished=true,result=v_data,finished_at=now() where game_id=p_game_id;
  else
    raise exception 'Unsupported challenge operation';
  end if;

  -- Every balance, point award, completion, and event is one transaction against the canonical
  -- shared users document. Row lock + version predicate prevent lost updates and duplicate awards.
  if v_user_target is not null then
    select count(*) into v_user_matches from jsonb_array_elements(v_users) e(user_row) where e.user_row->>'id'=v_user_target;
    if v_user_matches<>1 then raise exception 'Target user state unavailable'; end if;
    select e.user_row into v_user from jsonb_array_elements(v_users) e(user_row) where e.user_row->>'id'=v_user_target limit 1;
    begin v_points:=coalesce(nullif(v_user->>'points','')::numeric,0); exception when others then v_points:=0; end;
    begin v_total_points:=coalesce(nullif(v_user->>'totalPoints','')::numeric,0); exception when others then v_total_points:=0; end;
    begin v_tickets:=coalesce(nullif(v_user->>'challengeTickets','')::numeric,0); exception when others then v_tickets:=0; end;
    if v_tickets+v_ticket_delta<0 then raise exception 'Insufficient challenge tickets'; end if;
    if v_user_target=v_actor then v_target_name:=coalesce(nullif(v_user->>'name',''),v_actor_name,v_actor);
    else
      v_target_name:=coalesce(nullif(v_user->>'name',''),v_user->>'username',v_user_target);
    end if;
    v_user_next:=v_user||jsonb_build_object('points',v_points+v_point_delta,'totalPoints',greatest(0,v_total_points+v_point_delta),'challengeTickets',greatest(0,v_tickets+v_ticket_delta));
    select jsonb_agg(case when e.user_row->>'id'=v_user_target then v_user_next else e.user_row end order by e.ordinality)
      into v_users_next from jsonb_array_elements(v_users) with ordinality e(user_row,ordinality);
    update public.shared set data=jsonb_set(data,'{value}',to_jsonb(v_users_next::text),true),version=version+1,updated_at=now()
      where id='users' and version=v_users_version;
    get diagnostics v_award_count=row_count;
    if v_award_count<>1 then raise exception 'Concurrent user state update'; end if;
    if v_event_text is not null then
      insert into public.student_challenge_events(owner_legacy_id,event_text,icon)
      values(v_user_target,left(v_event_text,500),v_event_icon);
    end if;
    if p_op='ayat_submit' then v_data:=v_data||jsonb_build_object('ticketBalance',greatest(0,v_tickets+1)); end if;
    if p_op='ayat_award_winner' then v_data:=v_data||jsonb_build_object('winnerName',v_target_name); end if;
  end if;

  return jsonb_build_object('ok',true,'data',coalesce(v_data,'{}'::jsonb));
end;
$$;

revoke all on function public.student_challenges_action(uuid,text,integer,text,uuid,uuid,text) from public, anon, authenticated;
grant execute on function public.student_challenges_action(uuid,text,integer,text,uuid,uuid,text) to service_role;
commit;
