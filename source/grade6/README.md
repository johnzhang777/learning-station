# 六年级每日英语词汇

| 学期 | 学习日期 | 积累日 | 教材词条 | 拓展词 | 复习日期 | 短文 |
| --- | --- | ---: | ---: | ---: | --- | ---: |
| 六上 | 2028-09-01 至 2029-01-15 | 76 | 144 | 152 | 2028-12-16 至 2029-01-15 | 11 |
| 六下（旧版过渡） | 2029-02-15 至 2029-07-31 | 97 | 91 | 194 | 2029-07-01 至 2029-07-31 | 12 |

周一至周五每天安排 3 个教材词、2 个拓展词。周六回顾本周词汇，周日休息。教材词首次学习分别在 2028 年 12 月 15 日和 2029 年 6 月 29 日前完成，包含当天。再次出现的教材词标为本学期复现。六上 `run` 在第 2 单元练习“跑”，在第 6 单元练习“运转”，按两条义项计。

复习阶段回顾六上 296 个、六下 285 个词条。每个完整学习周读 2–3 篇原创短文，短周按实际天数安排。短文约 90–100 词，配 3 道理解题、2 道填空和口头表达。短文译文与练习答案收在陪读版。每个词和两句例句、每篇短文及其逐句内容都有独立的英式和美式播放入口。

## 教材与音标

- 六上采用人教社当前公开的新版六上六个单元，核对附录 2 第 81–84 页。 [电子教材](https://book.pep.com.cn/1212001601265/) · [人教社配套资源](https://www.pep.com.cn/zslth/yyptzy/xypep/6s/)
- 六下按已公开的旧版过渡，核对附录 2 第 54–56 页的四个单元。2029 年春季可按学校实际用书对照。 [电子教材](https://book.pep.com.cn/1212001602145/) · [旧版原书公开存档](https://dfl.aku.edu.cn/__local/3/D2/93/12B07EC5BFBD2CE2A19E9242D60_9D6A82BA_821565.pdf) · [人教社配套资源](https://www.pep.com.cn/zslth/yyptypzj/xypep/6x/)
- 教材词保留课本单元及课文页码。拓展词在两个六年级学期之间、与两册教材词及四五年级已收录词条之间去重。
- 音标主要参考 Cambridge Dictionary。分词音标和比较级、过去式等变形的来源记在 `pronunciations.json`。六上 `read` 词卡播放原形 /riːd/，例句练习原形和过去式。六下词卡播放过去式 /red/。 [Cambridge 的两种读音](https://dictionary.cambridge.org/pronunciation/english/read)
- Zhuhai 和 Jinggangshan 采用教材所用的拼音专名，词卡注明音标对应的其他部分。Turpan 沿用旧版教材读法。例句、阅读、练习与站内音频为自编或预录合成内容。

## 可编辑资料与重建

- `textbook.tsv` 记录学期、单元、页码、教材词、词性、词义及两句例句。
- `extensions.tsv` 记录拓展词及两句例句。所有例句均配中文和场景。
- `stories.txt` 记录短文、译文、重点词、练习和参考答案。
- `pronunciations.json` 记录双口音音标、核对来源和必要的读音说明。
- `*-checks.json` 和 `*-audio-checks.json` 记录日历、教材覆盖和音频检查结果。

从仓库根目录运行下列命令。音频生成使用 `edge-tts`、`imageio-ffmpeg` 和 `mutagen`，本机安装位置为 `.private/audio-deps`。PDF 生成使用 ReportLab、pypdf、Arial 和微软雅黑。

```powershell
python -X utf8 scripts/build_grade6.py
python -X utf8 scripts/generate_grade5_audio.py --grade 6 --term autumn --jobs 4
python -X utf8 scripts/generate_grade5_audio.py --grade 6 --term spring --jobs 4
python -X utf8 scripts/build_grade5_pdfs.py --grade 6 --out D:\Codex\your-workspace\outputs --vendor D:\path\to\python-libraries
npm.cmd run build
npm.cmd test
```

修改朗读文本后，重新生成相应学期的音频索引和片段。正式站直接读取构建完成的 JSON、MP3 和 PDF。
