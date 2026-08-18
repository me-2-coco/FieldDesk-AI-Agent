import hashlib
import os
import re
import subprocess
import tempfile
from pathlib import Path


BASE_DIR = Path(__file__).resolve().parent
OCR_SOURCE = BASE_DIR / "tools" / "sn_ocr.m"
OCR_BINARY = BASE_DIR / "runtime" / "sn_ocr"


def _ensure_binary():
    """Compile the macOS Vision helper once, then reuse it."""
    OCR_BINARY.parent.mkdir(parents=True, exist_ok=True)
    if OCR_BINARY.exists() and OCR_BINARY.stat().st_mtime >= OCR_SOURCE.stat().st_mtime:
        return OCR_BINARY

    environment = dict(os.environ)
    environment.setdefault(
        "CLANG_MODULE_CACHE_PATH", str(BASE_DIR / "runtime" / "clang-cache")
    )
    result = subprocess.run(
        [
            "xcrun", "clang", "-fobjc-arc", str(OCR_SOURCE),
            "-framework", "Foundation", "-framework", "Vision",
            "-framework", "ImageIO", "-framework", "CoreGraphics",
            "-o", str(OCR_BINARY),
        ],
        capture_output=True,
        text=True,
        timeout=120,
        env=environment,
    )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "无法编译本地 SN 识别组件")
    return OCR_BINARY


def _candidate_score(value, context, confidence):
    score = confidence * 100
    letters = sum(char.isalpha() for char in value)
    digits = sum(char.isdigit() for char in value)
    if letters >= 2 and digits >= 6:
        score += 25
    if re.search(r"(?:S\s*/?\s*N|SN|序列号)", context, re.I):
        score += 45
    if value.startswith(("W", "R", "S")):
        score += 8
    return score


def extract_sn(ocr_lines):
    """Return the most likely machine serial number from Vision OCR output."""
    candidates = []

    for index, (confidence, text) in enumerate(ocr_lines):
        upper = text.upper()
        marker = re.search(r"(?:S\s*/?\s*N|序列号)\s*[:：]?\s*(.*)", upper)
        if marker:
            following = re.sub(r"[^A-Z0-9]", "", marker.group(1))
            if not following and index + 1 < len(ocr_lines):
                following = re.sub(r"[^A-Z0-9]", "", ocr_lines[index + 1][1].upper())
            for value in re.findall(r"[A-Z][A-Z0-9]{13,23}", following):
                candidates.append(
                    (_candidate_score(value, text, confidence) + 45, value, confidence)
                )

        compact = re.sub(r"[^A-Z0-9]", "", upper)
        compact = re.sub(r"^SN", "", compact)
        for value in re.findall(r"[A-Z][A-Z0-9]{13,23}", compact):
            if value.isalpha() or value.isdigit():
                continue
            candidates.append((_candidate_score(value, text, confidence), value, confidence))

    if not candidates:
        return {"sn": "", "confidence": 0.0, "needs_confirmation": True}

    score, value, confidence = max(candidates, key=lambda item: item[0])
    # OCR confidence is only one signal. A marker + plausible format is strong enough.
    reliable = score >= 95 and 14 <= len(value) <= 24
    return {
        "sn": value,
        "confidence": round(float(confidence), 3),
        "needs_confirmation": not reliable,
    }


def recognize_sn(image_bytes, suffix=".jpg"):
    binary = _ensure_binary()
    digest = hashlib.sha256(image_bytes).hexdigest()
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=True) as image_file:
        image_file.write(image_bytes)
        image_file.flush()
        result = subprocess.run(
            [str(binary), image_file.name],
            capture_output=True,
            text=True,
            timeout=45,
        )
    if result.returncode != 0:
        raise RuntimeError(result.stderr.strip() or "本地 OCR 识别失败")

    lines = []
    for raw_line in result.stdout.splitlines():
        confidence_text, separator, text = raw_line.partition("\t")
        if not separator:
            continue
        try:
            confidence = float(confidence_text)
        except ValueError:
            continue
        lines.append((confidence, text.strip()))

    extracted = extract_sn(lines)
    extracted["image_hash"] = digest
    extracted["ocr_lines"] = [text for _, text in lines]
    return extracted


def recognize_sn_from_uploads(uploaded_files):
    results = []
    for uploaded in uploaded_files or []:
        try:
            result = recognize_sn(uploaded.getvalue(), Path(uploaded.name).suffix or ".jpg")
            result["file_name"] = uploaded.name
            if result["sn"]:
                results.append(result)
        except (OSError, RuntimeError, subprocess.SubprocessError):
            continue

    if not results:
        return {"sn": "", "confidence": 0.0, "needs_confirmation": True, "file_name": ""}

    # Repeated recognition of the same SN across images is especially trustworthy.
    counts = {}
    for result in results:
        counts[result["sn"]] = counts.get(result["sn"], 0) + 1
    best = max(results, key=lambda item: (counts[item["sn"]], not item["needs_confirmation"], item["confidence"]))
    best = dict(best)
    if counts[best["sn"]] > 1:
        best["needs_confirmation"] = False
    best["matches"] = counts[best["sn"]]
    return best
