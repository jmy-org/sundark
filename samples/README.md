# Sample papers

The start screen offers these papers so a new reader can try Sundark without a PDF of their own.
Each file is the **first page only** of the arXiv version named below, cut out with PyMuPDF
(`insert_pdf(from_page=0, to_page=0)`, document metadata cleared). Nothing else was changed.
Each is distributed by arXiv under the Creative Commons Attribution 4.0 International license
(CC BY 4.0, https://creativecommons.org/licenses/by/4.0/). Only add papers under such a license
here: most arXiv papers carry arXiv's own non-exclusive license, which does not allow redistribution.

| File | Paper | Authors | Source | License |
| --- | --- | --- | --- | --- |
| `mamba-2312.00752v2-p1.pdf` | Mamba: Linear-Time Sequence Modeling with Selective State Spaces | Albert Gu, Tri Dao | https://arxiv.org/abs/2312.00752v2 | CC BY 4.0 |
| `chain-of-thought-2201.11903v6-p1.pdf` | Chain-of-Thought Prompting Elicits Reasoning in Large Language Models | Jason Wei, Xuezhi Wang, Dale Schuurmans, Maarten Bosma, Brian Ichter, Fei Xia, Ed Chi, Quoc Le, Denny Zhou | https://arxiv.org/abs/2201.11903v6 | CC BY 4.0 |
| `llama-2302.13971v1-p1.pdf` | LLaMA: Open and Efficient Foundation Language Models | Hugo Touvron, Thibaut Lavril, Gautier Izacard, Xavier Martinet, Marie-Anne Lachaux, Timothée Lacroix, Baptiste Rozière, Naman Goyal, Eric Hambro, Faisal Azhar, Aurelien Rodriguez, Armand Joulin, Edouard Grave, Guillaume Lample | https://arxiv.org/abs/2302.13971v1 | CC BY 4.0 |

The order (Mamba first) is `SAMPLES` in `app/main.py`; the start screen shows the first as its main action.
