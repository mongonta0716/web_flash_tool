#!/usr/bin/env python3

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path


def create_unique_path(destination: Path) -> Path:
    """同名ファイルがある場合、連番付きのファイル名を作る。"""
    if not destination.exists():
        return destination

    index = 1

    while True:
        candidate = (
            destination.parent
            / f"{destination.stem}-{index}{destination.suffix}"
        )

        if not candidate.exists():
            return candidate

        index += 1


def find_bin_files(search_root: Path) -> list[Path]:
    """
    検索元フォルダ配下の .pio_build_firmware フォルダを探し、
    その中にあるbinファイルを取得する。
    """
    bin_files: list[Path] = []

    for build_dir in search_root.rglob(".pio_build_firmware"):
        if not build_dir.is_dir():
            continue

        for bin_file in build_dir.rglob("*.bin"):
            if bin_file.is_file():
                bin_files.append(bin_file)

    return sorted(bin_files)


def move_bin_files(
    search_root: Path,
    destination_dir: Path,
    overwrite: bool,
    dry_run: bool,
) -> int:
    bin_files = find_bin_files(search_root)

    if not bin_files:
        print(
            ".pio_build_firmwareフォルダ内に"
            "binファイルが見つかりませんでした。"
        )
        print(f"検索元: {search_root}")
        return 0

    if not dry_run:
        destination_dir.mkdir(parents=True, exist_ok=True)

    moved_count = 0

    for source_path in bin_files:
        destination_path = destination_dir / source_path.name

        if destination_path.exists():
            if overwrite:
                pass
            else:
                destination_path = create_unique_path(destination_path)

        print(f"移動元: {source_path}")
        print(f"移動先: {destination_path}")
        print()

        if dry_run:
            continue

        try:
            if overwrite and destination_path.exists():
                destination_path.unlink()

            shutil.move(
                str(source_path),
                str(destination_path),
            )

            moved_count += 1

        except OSError as error:
            print(
                f"移動に失敗しました: {source_path}",
                file=sys.stderr,
            )
            print(
                f"理由: {error}",
                file=sys.stderr,
            )

    if dry_run:
        print(f"対象ファイル数: {len(bin_files)}")
        print("dry-runのため、ファイルは移動していません。")
    else:
        print(f"{moved_count}個のbinファイルを移動しました。")

    return moved_count


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "指定した検索元フォルダ配下にある"
            ".pio_build_firmware内のbinファイルを移動します。"
        )
    )

    parser.add_argument(
        "source",
        type=Path,
        help="検索元フォルダ",
    )

    parser.add_argument(
        "destination",
        type=Path,
        help="binファイルの移動先フォルダ",
    )

    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="移動先に同名ファイルがある場合は上書きする",
    )

    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="ファイルを移動せず、対象だけ表示する",
    )

    return parser.parse_args()


def main() -> int:
    args = parse_arguments()

    search_root = args.source.expanduser().resolve()
    destination_dir = args.destination.expanduser().resolve()

    if not search_root.exists():
        print(
            f"検索元フォルダが存在しません: {search_root}",
            file=sys.stderr,
        )
        return 1

    if not search_root.is_dir():
        print(
            f"検索元がフォルダではありません: {search_root}",
            file=sys.stderr,
        )
        return 1

    if search_root == destination_dir:
        print(
            "検索元と移動先に同じフォルダは指定できません。",
            file=sys.stderr,
        )
        return 1

    print(f"検索元: {search_root}")
    print(f"移動先: {destination_dir}")
    print()

    move_bin_files(
        search_root=search_root,
        destination_dir=destination_dir,
        overwrite=args.overwrite,
        dry_run=args.dry_run,
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
