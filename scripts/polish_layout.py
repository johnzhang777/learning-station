from pathlib import Path

site = Path(__file__).resolve().parents[1]
css = site / 'dist/styles.css'
text = css.read_text(encoding='utf-8').replace('body{margin:0;min-width:320px}', 'body{margin:0;min-width:0}')
rule = '@media(max-width:600px){.word-meaning,.example-zh{font-size:16px}.example-scene{font-size:13px}.play-small{font-size:13px;min-height:48px}.example-tag{font-size:12px}.review-card .review-zh{font-size:14px}.accent-row button{font-size:13px;min-height:44px}.tip{font-size:12px}}'
if rule not in text:
    text += '\n' + rule + '\n'
css.write_text(text, encoding='utf-8')
