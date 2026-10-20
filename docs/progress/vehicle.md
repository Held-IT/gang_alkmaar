# Vehicle module (physics, camera, input, audio) — progress notes

Owner files: src/physics/**, src/vehicle/physics/**, src/camera/**, src/core/input.ts, src/audio/**

## Review fixes (session 4)
- Respawn from the pause menu kept the pre-pause velocity (car launched off the new spawn and
  crashed). While frozen the body is KinematicPositionBased, and Rapier restores the old dynamic
  velocity on setBodyType(Dynamic), so placeAt's setLinvel(0) was lost. vehicle.ts: placeAt sets
  `zeroVelOnThaw` when frozen; setFrozen(false) then zeroes lin/ang velocity, wheel omega and the
  impact history. Plain pause / resume still keeps the speed. Verified with the review's s16
  steps: car stays at the Molen spawn at 0 km/h (was 52 km/h into a wall).
- Gamepad B (or A / Start) that closed the pause menu also reset the car (or pulled the handbrake /
  paused again): read() is not called while paused, so the edge history was stale. input.ts:
  when input is (re)enabled (or read() resumes after > 1 s) the current pad buttons are adopted
  without firing edges and every held button is latched (ignored, also for the level-based
  handbrake / horn) until released. Verified with steps-pad.json: 15.3 -> 15.0 km/h after B
  resume (was 0).
- Start-up hitch of createVehicleAudio (first call 670-750 ms, later 110-185 ms):
  * one shared real-time AudioContext for the app (creating the first one costs ~450 ms of audio
    device init on the dev machine); dispose() stops this car's sources and disconnects its
    graph instead of closing the context;
  * engine / noise / impact buffers cached per sample rate + synth parameters (petrol cars share
    most layers);
  * engineSynth: damped resonances evaluated with an exact two-term recurrence instead of
    exp() + sin() per sample (bit-identical output, ~4x faster);
  * new `prepareVehicleAudio(spec | specs)`: creates the context and fills the caches, yielding
    between buffers. game.ts (integration) calls it for the first car during loading and for all
    cars in the background once the menu is up.
  Result on 'hoog': first __debug.start() 746 ms -> 74 ms, later starts ~60 ms (car model + physics
  remain); createVehicleAudio itself 0.7-5 ms per car once prepared.
