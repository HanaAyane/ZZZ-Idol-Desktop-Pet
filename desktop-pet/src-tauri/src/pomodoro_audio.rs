//! One application-owned audio worker. Embedded original MP3s also work in installed bundles.
use rodio::Source;
use std::{
    io::Cursor,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

pub enum AudioCommand {
    Play(&'static str, f32),
    Volume(f32),
    Stop,
}
#[derive(Clone)]
pub struct AudioService {
    sender: mpsc::Sender<AudioCommand>,
    pub error: Arc<Mutex<Option<String>>>,
}
fn bytes(sound: &str) -> &'static [u8] {
    match sound {
        // A short neutral cue, separate from the break/resume event semantics.
        "reminder" => include_bytes!("../../resources/pomodoro/start.mp3"),
        "break" => include_bytes!("../../resources/pomodoro/break.mp3"),
        "resume" => include_bytes!("../../resources/pomodoro/resume.mp3"),
        "complete" => include_bytes!("../../resources/pomodoro/complete.mp3"),
        _ => include_bytes!("../../resources/pomodoro/start.mp3"),
    }
}
// Boundaries measured from the embedded start.mp3: two attacks at ~0.177s and
// ~0.443s. Keep each 265ms note in forward order; only swap their positions.
const START_NOTE_BEGIN_MS: usize = 170;
const START_NOTE_SPLIT_MS: usize = 435;
const START_NOTE_END_MS: usize = 700;

fn swapped_start_notes() -> Result<rodio::buffer::SamplesBuffer, String> {
    let decoder =
        rodio::Decoder::try_from(Cursor::new(bytes("start"))).map_err(|e| e.to_string())?;
    let channels = decoder.channels();
    let sample_rate = decoder.sample_rate();
    let samples: Vec<f32> = decoder.collect();
    let offset = |ms| sample_rate as usize * ms / 1000 * channels as usize;
    let (begin, split, end) = (
        offset(START_NOTE_BEGIN_MS),
        offset(START_NOTE_SPLIT_MS),
        offset(START_NOTE_END_MS),
    );
    if samples.len() < end {
        return Err("开始音效长度不足，无法交换音节".into());
    }
    let mut swapped = samples[..begin].to_vec();
    for note in [&samples[split..end], &samples[begin..split]] {
        let start = swapped.len();
        swapped.extend_from_slice(note);
        // A 5ms fade at the quiet cut edges prevents clicks without reversing
        // the attack or changing the note's pitch, speed, or stereo channels.
        let frames = note.len() / channels as usize;
        let fade = (sample_rate as usize * 5 / 1000).max(1);
        for frame in 0..frames {
            let gain = (frame.min(frames - 1 - frame) as f32 / fade as f32).min(1.0);
            for channel in 0..channels as usize {
                swapped[start + frame * channels as usize + channel] *= gain;
            }
        }
    }
    // Keep the original duration, replacing the discarded low-level tail with silence.
    swapped.resize(samples.len(), 0.0);
    Ok(rodio::buffer::SamplesBuffer::new(
        channels,
        sample_rate,
        swapped,
    ))
}
impl AudioService {
    pub fn new() -> Self {
        let (sender, receiver) = mpsc::channel();
        let error = Arc::new(Mutex::new(None));
        let errors = error.clone();
        std::thread::spawn(move || {
            let mut playback: Option<(rodio::Sink, rodio::OutputStream)> = None;
            loop {
                let command = match receiver.recv_timeout(Duration::from_millis(250)) {
                    Ok(command) => command,
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if playback.as_ref().is_some_and(|(sink, _)| sink.empty()) {
                            playback = None;
                        }
                        continue;
                    }
                };
                match command {
                    AudioCommand::Stop => playback = None,
                    AudioCommand::Volume(value) => {
                        if let Some((sink, _)) = &playback {
                            sink.set_volume(value);
                        }
                    }
                    AudioCommand::Play(sound, volume) => {
                        playback = None;
                        let result = (|| -> Result<_, String> {
                            let mut stream = rodio::OutputStreamBuilder::open_default_stream()
                                .map_err(|e| e.to_string())?;
                            stream.log_on_drop(false);
                            let sink = rodio::Sink::connect_new(stream.mixer());
                            sink.set_volume(volume);
                            if sound == "pause" {
                                sink.append(swapped_start_notes()?);
                            } else {
                                let source = rodio::Decoder::try_from(Cursor::new(bytes(sound)))
                                    .map_err(|e| e.to_string())?;
                                sink.append(source);
                            }
                            Ok((sink, stream))
                        })();
                        match result {
                            Ok(value) => {
                                playback = Some(value);
                                *errors.lock().unwrap() = None;
                                log::info!(target: "desktop_pet::pomodoro", "sound started: {sound}");
                            }
                            Err(e) => {
                                log::warn!(target: "desktop_pet::pomodoro", "audio unavailable: {e}");
                                *errors.lock().unwrap() =
                                    Some("铃声播放失败，请检查音频输出设备；计时仍在继续。".into());
                            }
                        }
                    }
                }
            }
        });
        Self { sender, error }
    }
    pub fn send(&self, command: AudioCommand) {
        let _ = self.sender.send(command);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use rodio::Source;
    #[test]
    fn pause_swaps_notes_and_keeps_each_note_forward() {
        let start = rodio::Decoder::try_from(Cursor::new(bytes("start"))).unwrap();
        let channels = start.channels() as usize;
        let rate = start.sample_rate() as usize;
        let pause = swapped_start_notes().unwrap();
        assert_eq!(pause.channels() as usize, channels);
        assert_eq!(pause.sample_rate(), start.sample_rate());
        let forward: Vec<f32> = start.collect();
        let swapped: Vec<f32> = pause.collect();
        assert_eq!(forward.len(), swapped.len());
        let offset = |ms| rate * ms / 1000 * channels;
        let begin = offset(START_NOTE_BEGIN_MS);
        let split = offset(START_NOTE_SPLIT_MS);
        let end = offset(START_NOTE_END_MS);
        let fade = offset(5);
        // Check entire interiors sample-for-sample, excluding only faded edges.
        let second_len = end - split;
        assert_eq!(
            &swapped[begin + fade..begin + second_len - fade],
            &forward[split + fade..end - fade]
        );
        assert_eq!(
            &swapped[begin + second_len + fade..end - fade],
            &forward[begin + fade..split - fade]
        );
        assert!(swapped[end..].iter().all(|sample| *sample == 0.0));
    }
    #[test]
    fn all_four_supplied_mp3s_decode_to_audio() {
        for sound in ["start", "break", "resume", "complete"] {
            let mut decoder = rodio::Decoder::try_from(Cursor::new(bytes(sound))).unwrap();
            assert!(decoder.sample_rate() > 0);
            assert!(
                decoder
                    .by_ref()
                    .take(100_000)
                    .any(|sample| sample.abs() > 0.0001),
                "{sound}"
            );
        }
    }
}
