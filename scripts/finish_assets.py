from pathlib import Path

site = Path(__file__).resolve().parents[1]
app = site / 'dist/app.js'
text = app.read_text(encoding='utf-8')
old = '听这天的5个词</button></aside>'
new = '听这天的5个词</button><button class="btn secondary wide" style="margin-top:9px;font-size:12px" data-action="day-full" data-day="${d.id}">${I("play")}连听词和例句</button></aside>'
if old in text:
    assert text.count(old) == 1
    app.write_text(text.replace(old, new), encoding='utf-8')
assert 'data-action="day-full"' in app.read_text(encoding='utf-8')
