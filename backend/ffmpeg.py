"""ffmpeg binary: system one if present, else the static build shipped by the imageio-ffmpeg wheel (k8s pods)."""
import shutil


def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


FFMPEG = ffmpeg_exe()
