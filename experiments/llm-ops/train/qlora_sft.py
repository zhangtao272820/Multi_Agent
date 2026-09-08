#!/usr/bin/env python3
"""
Minimal QLoRA SFT example for interview / lab use.

Requires a CUDA GPU with enough VRAM (16GB+ recommended; 24GB comfortable for 7B).
Do NOT expect this to run on GTX 1050 2GB — use a cloud GPU host.

Example:
  python qlora_sft.py --base_model Qwen/Qwen2.5-1.5B-Instruct --max_steps 60
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from datasets import Dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from trl import SFTConfig, SFTTrainer


def load_jsonl(path: Path) -> list[dict]:
    rows: list[dict] = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    if not rows:
        raise SystemExit(f"no rows in {path}")
    return rows


def format_row(tokenizer, row: dict) -> str:
    """Chat-style text; works for Instruct models that accept messages template."""
    user = row.get("instruction", "").strip()
    if row.get("input"):
        user = f"{user}\n\n输入：{row['input'].strip()}"
    assistant = row.get("output", "").strip()
    messages = [
        {"role": "user", "content": user},
        {"role": "assistant", "content": assistant},
    ]
    if getattr(tokenizer, "chat_template", None):
        return tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=False
        )
    return f"### User\n{user}\n\n### Assistant\n{assistant}"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Minimal QLoRA SFT")
    p.add_argument(
        "--base_model",
        default="Qwen/Qwen2.5-1.5B-Instruct",
        help="HF model id or local path",
    )
    p.add_argument(
        "--data_path",
        default=str(Path(__file__).parent / "data" / "sample.jsonl"),
    )
    p.add_argument(
        "--output_dir",
        default=str(Path(__file__).parent / "outputs" / "adapter-demo"),
    )
    p.add_argument("--max_steps", type=int, default=60)
    p.add_argument("--batch_size", type=int, default=1)
    p.add_argument("--grad_accum", type=int, default=8)
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--lora_r", type=int, default=16)
    p.add_argument("--lora_alpha", type=int, default=32)
    p.add_argument("--max_seq_len", type=int, default=1024)
    return p.parse_args()


def main() -> None:
    args = parse_args()
    data_path = Path(args.data_path)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    rows = load_jsonl(data_path)
    print(f"loaded {len(rows)} rows from {data_path}")

    bnb = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_use_double_quant=True,
        bnb_4bit_compute_dtype="bfloat16",
    )

    tokenizer = AutoTokenizer.from_pretrained(args.base_model, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    model = AutoModelForCausalLM.from_pretrained(
        args.base_model,
        quantization_config=bnb,
        device_map="auto",
        trust_remote_code=True,
    )

    texts = [format_row(tokenizer, r) for r in rows]
    ds = Dataset.from_dict({"text": texts})

    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=[
            "q_proj",
            "k_proj",
            "v_proj",
            "o_proj",
            "gate_proj",
            "up_proj",
            "down_proj",
        ],
    )

    sft_args = SFTConfig(
        output_dir=str(out_dir),
        max_steps=args.max_steps,
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        logging_steps=5,
        save_steps=max(args.max_steps, 1),
        bf16=True,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        packing=False,
        dataset_text_field="text",
        max_seq_length=args.max_seq_len,
        report_to=[],
    )

    trainer = SFTTrainer(
        model=model,
        args=sft_args,
        train_dataset=ds,
        peft_config=lora,
        processing_class=tokenizer,
    )

    trainer.train()
    trainer.model.save_pretrained(out_dir)
    tokenizer.save_pretrained(out_dir)

    meta = {
        "base_model": args.base_model,
        "data_path": str(data_path),
        "max_steps": args.max_steps,
        "note": "Adapter only. Evaluate with eval_prompts.jsonl before any Agent cutover.",
    }
    (out_dir / "run_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"saved adapter -> {out_dir}")
    print("Next: compare base vs adapter on eval_prompts.jsonl; do not auto-promote.")


if __name__ == "__main__":
    main()
