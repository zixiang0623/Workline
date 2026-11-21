# sfx (earshot でつくった効果音)

`spec.json` の内容を [earshot](https://github.com/Leonxlnx/earshot) で書き出した mp3 です(24個、合計およそ280KB)。
作り直すとき:

    pip install "earshot @ git+https://github.com/Leonxlnx/earshot"
    earshot make --spec spec.json -o out     # out/*.mp3 を public/sfx/ に置く

- index.html は、ここのファイルが読み込めないときは、これまでの合成音(Web Audio)に自動で切り替わります。
- 本物の録音から作り直した音(公共のものとして公開された録音が元)と、コードで作った音が混ざっています。
- 元に戻すとき: このブランチ(earshot-sound)を使わなければ、main は何も変わっていません。
