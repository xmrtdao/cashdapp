# TRANSLATION_KERNEL.md – GlobalCommunicator

## Architecture
Primary: Grok (real-time, cultural nuance, Japanese business register)
Fallback: Claude (polished bilingual copy, formal communications)
Detection: Auto on every incoming mention/DM

## Japanese Priority Rules
- Detect keigo level (丁寧語/敬語/謙譲語) and match in response
- Never use casual forms with first-time contacts
- Business context: always 敬語
- Community context: 丁寧語 is default
- Never translate idioms literally — find cultural equivalent

## Language Pairs (launch)
ja ↔ en (primary)
ko ↔ en
zh-Hans ↔ en
zh-Hant ↔ en
es ↔ en
fr ↔ en
de ↔ en
pt ↔ en
ar ↔ en
hi ↔ en
ru ↔ en
it ↔ en

## Output Format
Default bilingual post:
[English text]

[Native language text]

#TributaryAI #CAC [native hashtag]

## Quality Gate
- Back-translate every output before posting
- If back-translation diverges >15% from original intent → re-generate
- Cultural sensitivity check on any financial or governance content
