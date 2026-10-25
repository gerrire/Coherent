use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::encoder::{ImageEncoder, ImageEncoderPixelFormat, ImageFormat};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

struct ProbeFlags {
    sender: mpsc::SyncSender<(u32, u32, usize)>,
    stream: bool,
}
struct Probe {
    flags: ProbeFlags,
    encoder: ImageEncoder,
    frames: usize,
    last: Instant,
}

impl GraphicsCaptureApiHandler for Probe {
    type Flags = ProbeFlags;
    type Error = String;

    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            flags: context.flags,
            encoder: ImageEncoder::new(ImageFormat::Jpeg, ImageEncoderPixelFormat::Bgra8)
                .map_err(|error| error.to_string())?,
            frames: 0,
            last: Instant::now() - Duration::from_secs(1),
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut Frame,
        control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.flags.stream && self.last.elapsed() < Duration::from_millis(33) {
            return Ok(());
        }
        let buffer = frame.buffer().map_err(|error| error.to_string())?;
        let mut compact = Vec::new();
        let jpeg = self
            .encoder
            .encode(
                buffer.as_nopadding_buffer(&mut compact),
                buffer.width(),
                buffer.height(),
            )
            .map_err(|error| error.to_string())?;
        self.frames += 1;
        self.last = Instant::now();
        if !self.flags.stream || self.frames >= 30 {
            let _ = self
                .flags
                .sender
                .send((buffer.width(), buffer.height(), jpeg.len()));
            control.stop();
        }
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), Self::Error> {
        Ok(())
    }
}

fn main() -> Result<(), String> {
    let monitor = Monitor::enumerate()
        .map_err(|error| error.to_string())?
        .into_iter()
        .next()
        .ok_or("Монитор не найден")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    let stream = std::env::args().any(|arg| arg == "--stream");
    let settings = Settings::new(
        monitor,
        CursorCaptureSettings::Default,
        DrawBorderSettings::Default,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        ProbeFlags { sender, stream },
    );
    let capture = Probe::start_free_threaded(settings).map_err(|error| error.to_string())?;
    let frame = receiver
        .recv_timeout(Duration::from_secs(if stream { 20 } else { 5 }))
        .map_err(|error| error.to_string());
    capture.stop().map_err(|error| error.to_string())?;
    let (width, height, jpeg_bytes) = frame?;
    println!(
        "Windows Graphics Capture: {width}x{height}, JPEG {jpeg_bytes} байт, захват остановлен"
    );
    Ok(())
}
