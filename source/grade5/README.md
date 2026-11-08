# 五年级每日英语词汇

| 学期 | 日期 | 积累日 | 教材词 | 拓展词 | 复习阶段 | 短文 |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| 五上 | 2027-09-01 - 2028-01-15 | 76 | 120 | 152 | 2027-12-16 - 2028-01-15 | 12 |
| 五下 | 2028-02-15 - 2028-07-31 | 99 | 135 | 198 | 2028-07-01 - 2028-07-31 | 11 |

周一至周五积累，每日3个教材词＋2个适龄拓展词；周六回顾，周日休息。教材词按单元逐步引入，填充的教材复现明确记录在 `repeatedIds`。学习词次分别380、495，去重词条分别272、333。拓展词在两个五年级学期之间不重复，也不与四年级已有词库及两册五年级教材词重复。复习覆盖每学期全部不同词条，每天约12-16词；完整周每周2-3篇短文，最后不足一周按实际天数安排。

两学期复习采用相同的形式，短文内容和目标词分别适配本学期。23篇短文均为原创，每篇97-108词，配3道理解题、2道填空、口头表达、参考译文及答案。五下月份主题一次回顾12个月。

## 来源与范围

- [人教社五上电子教材](https://book.pep.com.cn/1212001501255/)，附录2 pp.80-82，按原单元、首次页码逐项核对119词；另纳入附录3 p.83列出的 `everything`，合计120词。
- [人教社五下电子教材](https://book.pep.com.cn/1212001502255/)，附录2 pp.81-83，常规词、词组和专名合计135词。
- [五上官方配套资源](https://www.pep.com.cn/zslth/yyptzy/xypep/5s/)、[五下官方配套资源](https://www.pep.com.cn/zslth/yyptzy/xypep/5x/)，核对单元标题和词表。
- 音标逐词参考 Cambridge Dictionary，词性、同形词另与 Oxford Learner's Dictionaries交叉核对；具体链接在 `pronunciations.json`。注意 Ms 为称谓，不是字母缩写MS；live为居住，close为关闭，desert为沙漠，refuse为拒绝。
- 10个词组/专名未采用未经核实的整条转写，明确显示已核验的分词音标；`Mount Taishan` 的 Mount核对词典，Taishan沿用教材汉语拼音，连读听配套音频。Labour Day有词典整条音标。
- 依据当前公开版本整理，2027-2028实际新印次尚未核实。教材认读词与运用词请以老师要求为准，覆盖全部词不表示全部统一要求听写。

## 可编辑文件与重建

- `textbook.tsv`：学期、单元、页码、教材词、词性与中文。
- `core-examples.tsv`：新增或更正的教材例句；已核对且语义相同的四年级例句可复用。
- `extensions.tsv`：350个拓展词，每词两句原创例句、逐句中文及场景。
- `stories.txt`：23篇短文、重点词、译文、题目与答案。
- `pronunciations.json`：核验后的US/UK音标和来源。
- `*-checks.json`、`*-audio-checks.json`：日历、覆盖、复习和音频完整性报告。

从仓库根目录执行：

```powershell
python -X utf8 scripts/build_grade5.py
python -X utf8 scripts/generate_grade5_audio.py --term autumn --jobs 4
python -X utf8 scripts/generate_grade5_audio.py --term spring --jobs 4
python -X utf8 scripts/build_grade5_pdfs.py --out D:\Codex\your-workspace\outputs --vendor D:\path\to\python-libraries
npm.cmd run build
npm.cmd test
```

音频生成需要 `edge-tts`、`imageio-ffmpeg`、`mutagen`，安装在忽略的 `.private/audio-deps` 中。PDF生成需要reportlab、pypdf和本机微软雅黑/Arial字体，字体不随仓库分发。网站上线直接使用已保存的JSON、MP3与PDF，不运行内容生成程序。

修改有声文本后务必重新生成对应学期音频。生成器按每段文本哈希校验缓存，完整成功后才替换公开音频索引；失败时保留原索引。音标与教材词表校对不是单靠机械计数完成，来源页和用法均经过核对。
