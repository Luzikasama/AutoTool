"""统一检查入口：一次跑完引擎侧的全部断言测试。

跑法：
    python tools/test_all.py          # 引擎侧九组
    python tools/test_all.py --ui     # 再加界面回归（需要先构建前端，使用假引擎与无头浏览器）

为什么要这个：测试以前各跑各的，很容易只跑一个就宣布"全过了"。
更糟的是某个测试卡住时没人发现（0.1.6 就出现过执行器测试"跑不完"、
后来没人再跑的情况）。这里给每个文件**单独计时 + 超时**，
任何一个失败或超时都会明确报出来，退出码非 0。
"""
import subprocess
import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / "tools"

CASES = [
    ("图结构与调用关系", TOOLS / "test_scriptgraph.py", 120),
    ("执行器行为", TOOLS / "test_executor_scripts.py", 300),
    ("可靠性（校验/广播/持有/时钟）", TOOLS / "test_reliability.py", 180),
    ("二次修正回归", TOOLS / "test_revision.py", 60),
    ("键鼠运行时间轴", TOOLS / "test_input_trace.py", 60),
    ("多轨时序调度", TOOLS / "test_timeschedule.py", 60),
    ("主副轴并发流程", TOOLS / "test_parallel_flow.py", 60),
    ("平面分叉与汇合", TOOLS / "test_flat_graph.py", 60),
    ("坐标变量与引用", TOOLS / "test_point_variables.py", 60),
    ("后台点击、统一时序与轮数同步", TOOLS / "test_editor_032.py", 60),
]


def run_one(label: str, script: Path, timeout: int) -> tuple[bool, str]:
    if not script.is_file():
        return False, "文件不存在"
    t0 = time.monotonic()
    try:
        proc = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env={**os.environ, "PYTHONIOENCODING": "utf-8"},
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return False, f"超时（>{timeout}s）"
    dt = time.monotonic() - t0
    if proc.returncode:
        print((proc.stdout or "")[-12000:])
        print((proc.stderr or "")[-12000:])
    tail = (proc.stdout or "").strip().splitlines()
    summary = tail[-1] if tail else (proc.stderr or "").strip().splitlines()[-1:] or ""
    if isinstance(summary, list):
        summary = summary[0] if summary else ""
    ok = proc.returncode == 0
    return ok, f"{dt:.1f}s  {summary}"


def run_ui_regression() -> tuple[bool, str]:
    t0=time.monotonic()
    env={**os.environ,'NODE_OPTIONS':''}
    try:
        proc=subprocess.run(['node',str(TOOLS/'test_workspace_ui.mjs')],cwd=str(ROOT),env=env,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=180)
    except subprocess.TimeoutExpired:return False,'界面回归超时'
    if proc.returncode:print((proc.stdout+proc.stderr)[-10000:])
    lines=proc.stdout.strip().splitlines()
    return proc.returncode==0,f'{time.monotonic()-t0:.1f}s  {lines[-1] if lines else "界面回归失败"}'


def main() -> int:
    with_ui = "--ui" in sys.argv
    print(f"检查入口：{ROOT}")
    failed: list[str] = []
    for label, script, timeout in CASES:
        print(f"\n== {label} ==")
        ok, info = run_one(label, script, timeout)
        print(("  ok   " if ok else "  FAIL ") + script.name + "  " + info)
        if not ok:
            failed.append(label)
    if with_ui:
        print("\n== 界面回归 ==")
        ok, info = run_ui_regression()
        print(("  ok   " if ok else "  FAIL ") + "test_workspace_ui.mjs  " + info)
        if not ok:
            failed.append("界面回归")

    print()
    if failed:
        print(f"失败 {len(failed)} 组：" + "、".join(failed))
        return 1
    print("全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
