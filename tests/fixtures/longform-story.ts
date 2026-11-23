import { episodePlanSchema, type EpisodePlan } from '../../src/shared/contracts.js';
import { dramaturgyIssues } from '../../src/shared/longform.js';

// Authored production material. Timings are edit durations, not model request durations.
export const sceneSpecs = [
  {
    title: '断界',
    goal: '发现并定位受困者',
    obstacle: '停电、遮挡与未知魔物',
    action: '沈烬循声返回站台',
    outcome: '发现周衡，必须有人协助救援',
    rows: `
4|远景固定|隔着站厅高窗，城市上空的结界裂出一道暗缝；雨水沿玻璃垂落。|station|雨、远处低鸣|
6|低机位中景|夜班工具车旁，沈烬收起扳手；一道震动让他停手。|shen,station|金属轻碰、通风机骤停|
5|特写|隔离门标识灯由蓝转黄，门内储备电源灯仍亮；旁边是人员侧门指示。|gate,station|三声警报，之后间歇鸣响|
7|中近景|沈烬停在撤离方向，听见站台深处的敲击，回身握紧手电。|shen|呼吸、远处三次敲击|
7|远景缓推|站台尽头，蚀光兽的四足轮廓从破损围挡后挤出，抬头追踪闪烁法光。|beast,station|装甲擦碰、低吼|
6|俯拍中景|周衡左腿被落下的轻型导管架压住；右手敲击地面，沈烬的手电照到他。|zhou,shen|敲击停止|周衡：这边。腿压住了。`,
  },
  {
    title: '借一点火',
    goal: '释放伤员并建立撤离路线',
    obstacle: '带余能的导管不能徒手搬开',
    action: '使用铜环转移残余法力',
    outcome: '伤员脱困，能力期限与侧门均已展示',
    rows: `
5|平视近景|沈烬蹲下检查周衡左腿，不直接抬动带火星的导管。|shen,zhou|呼吸、漏电火花|沈烬：别动，我先断掉余能。
6|手部特写|沈烬右手从腰间唯一工具袋取出一枚铜环，左手固定绝缘把手。|shen,ring|布料摩擦|
5|细节固定|右手隔着工作护片接触导体，细线状琥珀余焰从导管流向铜环，源头暗下。|shen,ring,effect|细密电灼声|
6|铜环特写|同一铜环由亮到暗，亮光在六秒内衰减为黑；右手本次没有伤。|ring,effect|音高下降直至消失|
5|双人中景|周衡看向熄灭的环，沈烬把它放回右腰袋，双手移开导管架。|shen,zhou,ring|导管拖动|周衡：还是只能留六秒？
6|低位近景|周衡左脚不能承重，沈烬把他的右臂搭上自己肩膀。|shen,zhou|压抑疼痛声|
6|门框中景|林霁从连廊方向进入，先观察通道，再看伤员；她的左前臂有蓝灰色护甲。|lin,station|快速脚步|
6|三分之二侧面|林霁压低掌心火光，指向连廊后的隔离区，接过伤员另一侧重量。|lin,shen,zhou|火光收敛|林霁：往检修区走，储备屏障还在。
5|空镜中景|连廊、隔离主门、带把手的人员侧门与外侧控制台同框；人行出口在镜头右后方。|gate,station|警报回响|`,
  },
  {
    title: '越亮越危险',
    goal: '护送周衡穿过站台',
    obstacle: '魔物接近，伤员移动缓慢',
    action: '林霁施法掩护',
    outcome: '法力吸引魔物，原撤离线失效',
    rows: `
6|侧向中景|沈烬和林霁扶着周衡向连廊移动；周衡左脚始终拖地。|shen,lin,zhou|不齐的脚步|
6|林霁近景|林霁注意到围挡后的动静，轻推沈烬继续向前。|lin,shen|装甲声逼近|林霁：扶稳他，别停。
6|兽头近景|蚀光兽越过围挡，头部朝向仍闪着余焰的导管。|beast|鼻息、爪擦地|
5|中景固定|林霁在伤员身后停下，掌心由暗红升为明亮橙色。|lin,effect|火焰聚集|
5|宽中景|一道低矮火幕封住站台侧入口，留出通往连廊的路。|lin,station,effect|火幕轰起|
6|兽侧面|蚀光兽立即转向火幕，装甲纹理被照亮，四足改变运动方向。|beast,effect|短促吼叫|
7|斜侧远景|魔物扑击火幕边缘，余焰沿甲片表面滑散，冲击扯落通道挡板。|beast,station,effect|撞击、火焰散开|
6|沈烬近景|沈烬回望新缺口，视线从魔物头部移到林霁发亮的右手。|shen|短促吸气|沈烬：它追的是你的火。
6|林霁中近景|林霁熄灭掌心余火，侧步退出原位置；肩部制服被碎片划破。|lin|布料撕裂、喘息|
6|魔物中景|魔物冲过林霁原来的位置，撞上仍在发光的栏杆。|beast,station|金属弯折|
6|连廊反打|三人退入连接通道，栏杆倒下挡住了原先最近的出口。|shen,lin,zhou,station|警报闷响|`,
  },
  {
    title: '看见规则',
    goal: '验证魔物追踪对象',
    obstacle: '通道缺乏足够移动空间',
    action: '观察熄火和小规模诱导',
    outcome: '确认能量优先，但诱饵只能维持六秒',
    rows: `
6|俯视建立|三人靠在连廊转角内；隔离区在前方，魔物停在站台侧。|shen,lin,zhou,station|通风震动|
6|周衡近景|周衡压住左腿工装，用另一只脚撑地，给扶他的沈烬减重。|zhou|喘息|
5|兽头特写|魔物左右偏头，原火源熄灭后短暂失去明确方向。|beast|搜索时的低鸣|
6|林霁近景|林霁抬起空手示意两人留在掩体内，目光确认两侧路线。|lin|衣料声|林霁：先别出拐角。
6|沈烬视线镜头|墙面应急导体残留一小段琥珀光，地面有通向站台另一侧的排水槽。|station,effect|细弱电流|
5|手部近景|沈烬再次取出同一铜环，先看自己的右掌，再接触墙面导体。|shen,ring|工具扣轻响|
6|侧面特写|沈烬调整接触位置，直到本镜头末帧才完成转移；铜环亮起，墙上那段光同时熄灭。|shen,ring,effect|微弱高频声|
2|低位中景，实速|上一镜头末帧完成转移；第0至2秒，沈烬把铜环沿排水槽推到远离三人的一侧。|shen,ring,station|铜环滚动|
1|双景深镜头，实速|第2至3秒，前景林霁保持熄火，后景魔物转向远处亮环。|lin,beast,ring|兽爪转向|沈烬：看火。
2|脚部跟拍，实速|第3至5秒，两人架起周衡，沿连廊向安全侧移动两步。|shen,zhou,lin|两快一慢的脚步|
1|环的细节，实速|第5至6秒，铜环光线衰减为暗，魔物抬头听见伤员移动声。|ring,beast,effect|高频声消失|
6|宽中景|三人还没走到下一个掩体，魔物从站台口重新转向他们。|shen,lin,zhou,beast|突然的低吼|
6|低位中景|沈烬压低身体，让周衡先靠上半高护栏，伤员移动速度成为障碍。|shen,zhou,station|护栏震动|
6|林霁视线镜头|林霁观察魔物与三人之间的距离，发现原方案没有留下足够撤离时间。|lin,beast|逼近的脚步|
6|周衡手部近景|周衡用右手勾住护栏，右脚撑地尝试前移，左腿始终不能承重。|zhou,station|布料和喘息|`,
  },
  {
    title: '能走的人',
    goal: '带伤员跨过暴露区',
    obstacle: '六秒不足以支持当前撤离速度',
    action: '林霁断后，沈烬被迫先送周衡到安全侧',
    outcome: '沈烬获得独自离开的机会，但林霁被困',
    rows: `
6|周衡脚部近景|周衡左腿突然失力，右手抓住沈烬袖口，移动中断。|zhou,shen|鞋底拖地|
6|周衡近景|周衡看见已经暗下的环，摇头示意不要再赌同一路线。|zhou|疼痛喘息|周衡：六秒，走不过去。
6|林霁侧面|林霁把伤员重量交给沈烬，转身挡在通道缺口前。|lin,shen,zhou|脚步停稳|
6|中景固定|林霁以短促火幕逼魔物侧移，给伤员制造转过掩体的瞬间。|lin,beast,effect|火焰、撞击|
6|低位动作|沈烬拖扶周衡越过黄色安全线，周衡抓住外侧栏杆。|shen,zhou,station|栏杆响动|
5|铜环细节|沈烬经过排水槽出口，用绝缘钳拾回已经熄灭的铜环。|shen,ring|钳口碰金属|
5|远景反打|挡板落在林霁与两人之间，只剩窄缝能看见她。|lin,station|沉重落响|
6|隔缝近景|林霁护甲擦过挡板，身体偏斜；她用肩膀顶住正在移动的金属边缘。|lin|吃力呼吸|
6|林霁近景|林霁看向沈烬，示意他先护送伤员往已亮起的安全出口。|lin|环境声压低|林霁：带他走。
6|沈烬中景|沈烬把周衡靠到控制台边，出口只在身后数步；他的身体朝出口，头仍望着窄缝。|shen,zhou,station|脚步逐渐远去的回声|
6|主观近景|窄缝里，林霁右手火光越来越弱，魔物装甲擦过她身后的挡板。|lin,beast|磨擦声|
5|沈烬手部|沈烬摸到工具袋里的铜环，转而把逃生手电交给周衡。|shen,zhou,ring|工具扣扣紧|
6|背面中景|沈烬离开通向地面的亮门，沿原路返回林霁所在的窄缝。|shen,station|坚定但仍急促的脚步|`,
  },
  {
    title: '还有一扇门',
    goal: '找出能同时保全三人的方案',
    obstacle: '林霁不能长期抵挡魔物',
    action: '释放挡板、核对隔离机构与人员侧门',
    outcome: '隔离计划成立，三人的分工明确',
    rows: `
6|窄缝近景|林霁听到回来的脚步，先绷紧，随后认出沈烬的工具灯。|lin,shen|工具灯开关|
6|沈烬近景|沈烬把支撑楔插入挡板底部，给林霁腾出侧身空间。|shen,lin|楔子敲入|沈烬：我知道另一扇门。
5|脚部细节|挡板抬起少许，林霁侧身穿过；楔子留在原处。|lin,station|金属轻移|
6|中景跟拍|两人退回周衡所在控制台，林霁全程维持熄火。|shen,lin,zhou|压低的呼吸|
6|设施建立镜头|控制台外侧、隔离区主门、人员侧门和内部固定导轨同时可辨。|gate,station|独立备用电源低鸣|
6|周衡手部及侧脸|周衡用手电照出侧门把手，指向从舱内到控制台侧的短通路。|zhou,gate|开关轻响|周衡：侧门通这里。主门我关。
6|沈烬行动中景|沈烬试推人员侧门，门能从舱内向外打开，外侧机械回位器使它自动闭合。|shen,gate|弹簧回位声|
5|门框细节|侧门关严后，门框蓝色细线恢复；主门储备屏障仍在待机。|gate,effect|低频接通声|
6|林霁近景|林霁看清入口、诱饵落点与侧门之间的路线，点头。|lin,station|呼吸放缓|
6|双人中景|林霁看向沈烬，第一次把战术决定交给他。|lin,shen|远处爪声|林霁：需要多少火？
6|沈烬手部特写|沈烬摆出铜环，示意掌心大小的余焰；他没有拿出第二枚环。|shen,ring|金属轻响|
5|周衡中景|周衡坐稳，把右脚撑在底座上，右手试拉控制杆，确认能独立操作。|zhou,gate|控制杆棘轮声|
6|三人关系镜头|林霁留在安全侧保护控制台，沈烬站在主门边，周衡手掌压在待机杆上。|shen,lin,zhou,gate|警报间隔变长|`,
  },
  {
    title: '代价',
    goal: '确认最后六秒可执行',
    obstacle: '主角承载余能的容量有限',
    action: '用较小残焰试验并调整分工',
    outcome: '伤手出现，仍决定承担诱导',
    rows: `
6|林霁掌心近景|林霁在导体上留下短小残焰，随后熄灭自身法光并退开。|lin,effect|短促燃烧|
6|沈烬近景|沈烬确认源头已经离开林霁身体，才伸出持环右手。|shen,lin,ring|呼吸|沈烬：只留余火，别再加。
6|手部特写|余焰进入铜环，右手工作护片边缘发焦；沈烬立即停止继续吸收。|shen,ring,effect|焦灼、吸气|
5|反应近景|沈烬将环放到耐热托盘上，手指短暂发抖；第三秒前试验光线完全熄灭。|shen,ring|托盘轻响|
5|周衡近景|周衡将控制杆拉到预备位，肩膀抵住台边，表示自己能完成关门。|zhou,gate|机械定位|周衡：你回来，我就落门。
6|俯视固定|画面建立主门到诱饵落点再到侧门的短路径；工具托盘位于主门内侧。|gate,station,ring|备用电源|
7|沈烬侧面中景|沈烬空手演练跨进主门、回身穿出侧门，走完路线只需几步。|shen,gate|连续脚步|
6|林霁近景|林霁注意到沈烬右掌发红，用自己的备用护布包住他的腕部，不覆盖需要接触的掌面。|lin,shen|撕布声|
6|手部近景|沈烬检查手指仍能张合，将唯一铜环重新握稳，环仍是暗的。|shen,ring|布料、金属|
6|魔物远景|魔物挤开最后一块挡板，面向隔离区入口；前方没有新的路可退。|beast,station|挡板倒落|
6|林霁双人近景|林霁看着沈烬受伤的手，随后退到事先确认的安全位置。|lin,shen|紧张呼吸|林霁：别等火灭了才跑。`,
  },
  {
    title: '最后六秒',
    goal: '完成诱导与隔离，三人全部撤出',
    obstacle: '魔物逼近，启动时机只有一次',
    action: '依次就位，最后六秒实施预定方案',
    outcome: '魔物被隔离，主角伤势加重',
    rows: `
6|控制台中景|周衡握紧预备杆，视线能看见人员侧门；他的左腿仍不能支撑站立。|zhou,gate|棘轮轻响|
6|兽的低位中景|蚀光兽压向最后一段弯折栏杆，甲片擦出粉尘；栏杆正一点点被压低。|beast,station|金属弯曲、爪擦地|
6|周衡近景|周衡看一眼沈烬，拉到预备位的手没有松开。|zhou|警报短鸣|周衡：门准备好了。
6|侧门低位近景|震动让一片薄金属滑进侧门回位轨迹，门缝留下指宽空隙；沈烬看见蓝线无法闭合。|shen,gate,station|门框轻磕、电源低鸣中断|
6|沈烬手部中景|沈烬用工具钳夹住碎片，右手伤痛使钳口打滑；他立即换左手固定，不再硬拽。|shen,gate|钳口滑动、压抑吸气|
6|双人侧面|林霁按住正在弹回的门，沈烬左手拉出碎片；她先护住他伤手，再示意他退开。|lin,shen,gate|金属拖出、衣料摩擦|
6|魔物斜侧中景|蚀光兽撞弯最后一段栏杆，前足跨过，后足仍受阻；人物听见阻挡即将失效。|beast,station|栏杆断裂前的尖响|
6|侧门细节与反应|沈烬松开门，让回位器自行合上；蓝线恢复。他回头确认周衡已经看见这个信号。|shen,zhou,gate|门锁咔哒、稳定低鸣|
6|林霁近景|林霁在安全侧看向沈烬，稳住呼吸；她不再制造第二个火源。|lin,shen|呼吸|林霁：照刚才的路。
6|沈烬低位中景|沈烬把钳子放回腰袋，确认人员通路无物，跨到主门内侧的定位线；铜环仍暗。|shen,ring,gate|工具入袋、鞋底落地|
6|魔物侧面|最后一段栏杆倒下，蚀光兽进入短直道，朝人的脚步声抬头。周衡看见它越过拐角。|beast,zhou,station|金属落地、警报|
6|沈烬面部近景|沈烬向林霁举起未发光的铜环，眼睛紧盯地面标记；此时没有启动六秒计时。|shen,lin,ring|短促吸气|沈烬：等它过线。
6|两侧交叉中景|林霁在门边导体留下掌心大小的残焰，立即熄灭自身火光并退到周衡身旁；魔物转向新火源。|lin,zhou,beast,effect|焰声短起、兽爪转向|
6|动作建立中景|沈烬在主门内侧屏住呼吸，侧门在右后方；魔物循刚亮起的余焰加速过线，右手在最后一帧触向导体。|shen,beast,gate,ring,effect|脚步加速、低频抬升|
3|连续宽中景，实速|第0秒右掌触导体，源头熄灭、环亮；第1秒铜环滑入内侧托盘；第2至3秒魔物扑入追环，沈烬转向侧门。|shen,beast,ring,gate,effect|转移、铜环滑动、兽扑地|
3|接上镜连续实速|第3至4秒沈烬穿出侧门；第4秒侧门回位，周衡落杆；第5至6秒主门屏障合拢，环灭，魔物撞在屏障内侧。|shen,zhou,beast,gate,ring|门合、低沉撞击、余焰熄灭|`,
  },
  {
    title: '门外的人',
    goal: '确认救援完成并呈现代价',
    obstacle: '疲惫、伤势与事后不确定',
    action: '核对隔离状态，相互照应撤离',
    outcome: '三人安全，伤势与关系变化保留',
    rows: `
6|屏障内外远景|魔物再次撞击但无法穿出，主门与侧门的蓝色线同时稳定。|beast,gate|隔着门的闷响|
6|沈烬中景|沈烬背靠安全侧墙面坐下，右手抬不起来；没有镜头让他突然恢复。|shen|急促喘息渐缓|
6|周衡近景|周衡先看见安全侧的两人，再看稳定指示灯，松开已经机械锁定的杆。|zhou,gate|杆件锁定|周衡：关住了。
6|林霁手部近景|林霁确认沈烬右手伤势，重新固定腕部护布。|lin,shen|衣料声|
6|主角视线镜头|透过门上的窄观察窗，唯一铜环留在内侧托盘，完全熄灭。|ring,gate|室内余响|
6|三人中景|周衡扶着栏杆站起，林霁与沈烬共同调整站位，把较多重量移到林霁一侧。|shen,lin,zhou|移动脚步|
6|道具特写|沈烬尝试用右手收起扳手，握力不足；林霁接过扳手，放进自己的腰袋。|shen,lin|金属轻响|
6|林霁侧面近景|林霁把沈烬的左臂搭到肩上，目光从他的工具袋移到脸上。|lin,shen|平稳呼吸|林霁：手先别用力。
7|出口背面中景|三人沿人行出口向微亮的地面走去，站内屏障持续稳定，天边仍有远处裂隙余光。|shen,lin,zhou,station|雨声逐渐清楚|`,
  },
  {
    title: '下一班',
    goal: '完成角色关系回报与系列入口',
    obstacle: '主角仍认为自己只能维修',
    action: '林霁提出协作邀请，沈烬接受',
    outcome: '人物可续，本次救援已闭环',
    rows: `
5|出口双人近景|林霁把临时协作臂章交到沈烬未受伤的左手，保持同一制服与护布状态。|lin,shen|雨滴|林霁：下一班，跟我巡界。
5|沈烬近景|沈烬看一眼伤手，再握住臂章，抬头回应，表情疲惫但坚定。|shen|雨、一次轻呼气|沈烬：我认得这些门。
5|片名静帧|黑底片名：灰港守夜人 / 最后一道门。|title|雨声从已采用 H3 原声延续|
5|制作信息静帧|原创短剧；图片由 Codex 制作，视频与原声由 H3 生成；保留真实制作信息。|title|雨声淡出|`,
  },
];

export const identities = [
  {
    key: 'shen',
    name: '沈烬',
    type: 'character',
    subtype: 'adult-human',
    description:
      '22岁东亚男性，偏瘦结实，短黑发，左眉尾有浅淡旧疤；灰蓝维修外套，深灰工装裤，右腰单个工具袋。唯一铜环始终有明确去向。',
    fixed: ['同一张脸与短黑发', '左眉尾旧疤', '右腰工具袋', '右手为能力接触手'],
    views: ['front', 'left', 'right', 'back', 'three_quarter', 'detail'],
  },
  {
    key: 'lin',
    name: '林霁',
    type: 'character',
    subtype: 'adult-human',
    description:
      '25岁东亚女性，黑发低束，轮廓清楚，深蓝巡界短外套与长裤，左前臂蓝灰护甲；火光源自右手。实用职业服装，无夸张裸露。',
    fixed: ['黑发低束', '左前臂护甲', '深蓝同款制服', '右手火系施法'],
    views: ['front', 'left', 'back', 'three_quarter', 'detail'],
  },
  {
    key: 'zhou',
    name: '周衡',
    type: 'character',
    subtype: 'adult-human',
    description:
      '50岁东亚男性，短灰黑发，藏青工作服配暗橙反光条；本集左腿受伤，右脚承重，熟悉车站设备。',
    fixed: ['左腿受伤', '相同工作服', '灰黑短发'],
    views: ['front', 'three_quarter', 'detail'],
  },
  {
    key: 'beast',
    name: '蚀光兽',
    type: 'character',
    subtype: 'fantasy-quadruped',
    description:
      '一只成年牛体量的四足魔物，黑曜石色分段装甲，细窄头部，背脊单列低矮甲片；无翅膀、无人手。装甲缝隙在靠近法光时反射暗琥珀色。',
    fixed: ['四足与单头', '无翅膀', '固定甲片排列', '全片只有一只'],
    views: ['front', 'left', 'right', 'back', 'three_quarter', 'detail'],
  },
  {
    key: 'station',
    name: '灰港东站',
    type: 'environment',
    subtype: 'modern-magic-station',
    description:
      '雨夜现代交通站，冷灰混凝土、暗蓝金属、少量暖黄应急光；站台经连廊到检修隔离区，安全侧有人行出口。',
    fixed: ['三个相连区域', '连续的建筑材质', '相同雨夜与应急光'],
    views: ['custom', 'custom', 'custom', 'top'],
  },
  {
    key: 'ring',
    name: '储能铜环',
    type: 'object',
    subtype: 'maintenance-tool',
    description:
      '掌心大小的单枚旧铜环，环上一道黑色绝缘握片；容量有限，琥珀光由一端流入后在六秒内熄灭。',
    fixed: ['只有一枚', '相同尺寸与绝缘片', '暗铜材质'],
    views: ['detail'],
  },
  {
    key: 'gate',
    name: '检修隔离机构',
    type: 'object',
    subtype: 'barrier-system',
    description:
      '主门通往危险检修舱；一扇独立人员侧门通向外侧控制台；备用能源独立于损坏结界；主门屏障须人员侧门关严后才可锁定。',
    fixed: ['主门/侧门/外侧控制台的关系', '独立备用电源', '人员侧门自动回位'],
    views: ['detail'],
  },
  {
    key: 'effect',
    name: '残焰视觉规范',
    type: 'style',
    subtype: 'magic-effect',
    description:
      '琥珀色细线沿导体转移，源头必须同时暗下；铜环承载时发光，不改变几何；衰减时亮度与音高一起下降，六秒结束为暗铜。',
    fixed: ['源头消失才进入目标', '固定琥珀色', '只一份有效余能', '环境受光方向与来源相符'],
    views: ['custom', 'custom', 'custom'],
  },
];

export const voiceProfiles = {
  shen: 'Young adult Mandarin male voice, mid-low register, slightly breathy under stress, measured short clauses. No narrator.',
  lin: 'Adult Mandarin female voice, lower-mid register, clear controlled delivery, breath breaks under exertion. No narrator.',
  zhou: 'Middle-aged Mandarin male voice, rough low register, short phrases limited by pain. No narrator.',
};

export function grayportPlan(): EpisodePlan {
  const shots: any[] = [],
    scenes: any[] = [];
  const goals = [
    '观众知道求救者在站台深处',
    '余能转移、铜环六秒期限、出口结构已展示',
    '强攻引来追逐，最近撤离路被破坏',
    '同一诱饵只提供短暂窗口',
    '主角有机会离开，主动选择返回',
    '设施与人物分工为高潮提供依据',
    '伤手代价发生，路线经过实地检查',
    '六秒内完成诱导、撤离、关门',
    '明确三人获救，伤势没有消失',
    '合作邀请完成，片尾保持真实制作信息',
  ];
  for (const [i, scene] of sceneSpecs.entries()) {
    const sceneId = `S${String(i + 1).padStart(2, '0')}`,
      ids: string[] = [];
    const rows = scene.rows.trim().split('\n');
    for (const [j, row] of rows.entries()) {
      const [duration, camera, description, actors, sound, dialogue = ''] = row.split('|');
      const id = `${sceneId}-${String(j + 1).padStart(2, '0')}`;
      ids.push(id);
      const participants = actors.split(',');
      shots.push({
        id,
        scene: sceneId,
        description,
        dialogue,
        continuity: '身体左右以主体自身为准；铜环只有一枚；周衡左腿受伤；高潮后沈烬右掌伤势保留。',
        duration: Number(duration),
        production: {
          purpose: goals[i],
          camera,
          startState: j ? `${ids[j - 1]} 的动作结果保持；${scene.goal}` : scene.goal,
          endState: description,
          sound,
          magic: participants.includes('effect')
            ? '按残焰规则：有来源、有导体、六秒上限、单份容量；源与目标不可同时凭空增亮。'
            : '本镜头不增加未声明法术。',
          instanceIds: participants.filter(
            (a) => !['title', 'effect', 'station', 'gate', 'ring'].includes(a),
          ),
          requiredViews: participants
            .filter((a) => a !== 'title')
            .map(
              (a) =>
                `${a}:${camera.includes('近') || camera.includes('特写') ? 'detail' : 'three_quarter'}`,
            ),
          acceptance: [
            '动作与本镜头描述一致',
            '主体数量、空间方向和道具归属正确',
            '音轨无新增旁白或配乐',
            ...(dialogue ? ['中文台词准确，只有指定人物说话'] : []),
          ],
          delivery: actors === 'title' ? 'title' : 'generated',
        },
      });
    }
    scenes.push({
      id: sceneId,
      title: scene.title,
      targetFrames: shots
        .filter((s) => s.scene === sceneId)
        .reduce((n, s) => n + s.duration * 24, 0),
      goal: scene.goal,
      obstacle: scene.obstacle,
      action: scene.action,
      outcome: scene.outcome,
      shotIds: ids,
    });
  }
  const segments = shots
    .filter((s) => s.production.delivery === 'generated' && s.id !== 'S08-16')
    .map((s) => ({
      id: `G-${s.id}`,
      shotIds: s.id === 'S08-15' ? ['S08-15', 'S08-16'] : [s.id],
      mode: 'ref2va' as const,
      duration: s.id === 'S08-15' ? 10 : s.duration <= 5 ? 5 : 10,
      prompt: `待参考包审核后编译。镜头 ${s.id}：${s.description} ${s.dialogue}。${s.production.sound}；无旁白，无配乐。`,
      references: [],
      guides: [],
      generationMode: 'formal' as const,
    }));
  const plan = episodePlanSchema.parse({
    title: '第一集 · 最后一道门',
    summary:
      '只能短暂搬运余能的维修学徒，与巡界法师合作救援受困技术员，利用提前建立的规则完成魔物隔离。',
    script: shots
      .map(
        (s) => `${s.id}（${s.duration}秒）${s.description}${s.dialogue ? '\n' + s.dialogue : ''}`,
      )
      .join('\n\n'),
    sourceChapterIds: [],
    shots,
    segments,
    incoming: { inheritPrevious: false, time: '同一雨夜', confirmed: false },
    outgoing: {
      status: 'planned-only',
      survivors: ['shen', 'lin', 'zhou'],
      shenRightHand: '灼伤，握持受限',
      ring: '留在隔离舱内，已熄灭',
      beast: '隔离舱内，仍存活',
      relationship: '临时巡界协作邀请已接受',
    },
    openLoops: ['主角康复期间如何参与巡界？'],
    preproductionPackage: 'grayport-ep01',
    dramaturgy: {
      version: 1,
      targetFrames: 14400,
      canvas: { width: 1080, height: 1920 },
      theme: '力量的价值，体现在愿意为谁承担代价。',
      scenes,
      rules: [
        {
          id: 'conservation',
          rule: '转移已有残余法力，源头同时暗下',
          setupShotIds: ['S02-03'],
          payoffShotIds: ['S08-15'],
        },
        {
          id: 'six-seconds',
          rule: '铜环只保留六秒，一次仅一份有效余能',
          setupShotIds: ['S02-04', 'S04-11'],
          payoffShotIds: ['S08-15', 'S08-16'],
        },
        {
          id: 'predator',
          rule: '魔物优先追逐较强活跃法力，装甲抵挡常规攻击',
          setupShotIds: ['S03-06', 'S03-07', 'S04-09'],
          payoffShotIds: ['S08-15'],
        },
        {
          id: 'side-exit',
          rule: '人员侧门先关闭，外侧控制台才能锁定主屏障',
          setupShotIds: ['S02-09', 'S06-05', 'S06-07', 'S06-08'],
          payoffShotIds: ['S08-16'],
        },
        {
          id: 'cost',
          rule: '过量承载会灼伤主角右掌，不能立即恢复',
          setupShotIds: ['S07-03', 'S07-04'],
          payoffShotIds: ['S09-02', 'S09-07'],
        },
      ],
      plannedCanon: [
        { id: 'survivors', fact: '沈烬、林霁、周衡完成撤离', evidenceShotIds: ['S09-09'] },
        {
          id: 'injury',
          fact: '沈烬右掌灼伤，周衡左腿受伤，后续须保留',
          evidenceShotIds: ['S09-02', 'S09-06', 'S09-07'],
        },
        { id: 'ring', fact: '唯一铜环留在隔离舱内且已熄灭', evidenceShotIds: ['S09-05'] },
        { id: 'beast', fact: '蚀光兽存活但被稳定屏障隔离', evidenceShotIds: ['S09-01'] },
        {
          id: 'role',
          fact: '沈烬接受临时巡界协作身份，未自动提升魔法等级',
          evidenceShotIds: ['S10-01', 'S10-02'],
        },
      ],
    },
  });
  const issues = dramaturgyIssues(plan);
  if (issues.length) throw new Error(issues.join('; '));
  return plan;
}
