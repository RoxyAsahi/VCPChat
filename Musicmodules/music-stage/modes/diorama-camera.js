(function (global) {
    'use strict';
    const { clamp, hashString } = global.MusicStageRuntime;
    const { smooth, upperBound } = global.MusicStageDioramaDirector;
    const mix = (a, b, p) => a + (b - a) * p;
    const noise = (time, seed) => {
        const i = Math.floor(time);
        const value = n => hashString(`${seed}:${n}`) / 4294967295 * 2 - 1;
        return mix(value(i), value(i + 1), smooth(time - i));
    };
    // Horizontal unit-speed curve. Integrate headings on a fixed spatial grid,
    // so arc length really is metres (not a spline's arbitrary parameter).
    const createTrack = (timeline, speed = 1, options = {}) => {
        const step = 2;
        const length = timeline.distanceAt(timeline.duration, speed) + 600;
        const count = Math.ceil(length / step);
        const x = new Float64Array(count + 1), z = new Float64Array(count + 1);
        const phase = timeline.seedHash / 4294967295 * Math.PI * 2;
        const heading = s => 0.12 * Math.sin(s / 180 + phase)
            + 0.045 * Math.sin(s / 73 + phase * 0.7);
        for (let i = 1; i <= count; i++) {
            const yaw = heading((i - 0.5) * step);
            x[i] = x[i - 1] + Math.sin(yaw) * step;
            z[i] = z[i - 1] - Math.cos(yaw) * step;
        }
        const at = distance => {
            const s = clamp(distance, 0, count * step);
            const index = Math.min(count - 1, Math.floor(s / step));
            const p = (s - index * step) / step;
            const yaw = heading(s);
            const forward = { x: Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
            const right = { x: Math.cos(yaw), y: 0, z: Math.sin(yaw) };
            const extension = distance < 0 ? distance : Math.max(0, distance - count * step);
            return {
                position: { x: mix(x[index], x[index + 1], p) + forward.x * extension,
                    y: 0, z: mix(z[index], z[index + 1], p) + forward.z * extension },
                forward, right, yaw
            };
        };
        const plan = global.MusicStageDioramaDirector.planEncounters(timeline, { ...options, cameraSpeed: speed });
        plan.encounters.forEach(encounter => {
            const frame = at(encounter.address);
            // The first encounter is to the right; successive encounters
            // alternate sides without ever creating a second screen per page.
            encounter.side = encounter.id % 2 === 0 ? 1 : -1;
            // When the next line is written on the sky, this screen is the last
            // of its run and nothing is read after it: it stands well back from
            // the line, so it is out of the picture when the camera looks ahead.
            const phrases = timeline.phrases || [];
            const next = phrases[upperBound(phrases, encounter.end - 0.001, 'start')];
            const skyNext = Boolean(next) && !plan.pageEncounter.has(next.id);
            if (skyNext && next.start - encounter.end < 10) encounter.lateral = 21;
            encounter.position = {
                x: frame.position.x + frame.right.x * encounter.lateral * encounter.side,
                y: 4.6,
                z: frame.position.z + frame.right.z * encounter.lateral * encounter.side
            };
            const middle = at((encounter.startDistance + encounter.endDistance) * 0.5);
            encounter.yaw = Math.atan2(encounter.position.x - middle.position.x,
                middle.position.z - encounter.position.z);
            // Large enough that lyric and translation are both legible from the
            // far end of the reading span, still inside the frame at the near end.
            encounter.width = Math.min(16, 18.5 * Math.max(0.45, options.aspect || 1.6));
            encounter.height = 4.2;
            // When the next line is written on the sky, the camera has to let go
            // of this screen by then, or the screen stands in front of that line.
            encounter.skyStart = skyNext ? next.start : Infinity;
        });
        // Compile continuous yaw cues, including interrupted transitions.
        const cues = timeline.acts.slice(1).map(act => ({ time: act.start, rig: rigFor(act) }));
        if (options.cameraCuts !== false) timeline.cuts.forEach(cut =>
            cues.push({ time: cut.time, rig: cut.rig || rigFor(timeline.acts[cut.actIndex]) }));
        cues.sort((a, b) => a.time - b.time);
        const turns = [];
        const initialYaw = rigYaw(rigFor(timeline.acts[0]));
        for (const cue of cues) {
            const last = turns[turns.length - 1];
            const from = last ? mix(last.from, last.to, smooth((cue.time - last.time) / 3.5)) : initialYaw;
            turns.push({ time: cue.time, from, to: rigYaw(cue.rig) });
        }
        return { at, encounters: plan.encounters, pageEncounter: plan.pageEncounter, turns, initialYaw,
            scenes: planScenes(timeline, options) };
    };
    const CHASE_LATERAL = 7.5;
    const CHASE_LEAD = 66;
    const chaseAmount = height => smooth((height - 3.9) / 0.7);
    // Starts and stops without a jolt: no speed and no acceleration at either end.
    const ease = value => { const p = clamp(value); return p * p * p * (p * (p * 6 - 15) + 10); };
    /*
     * Leaving the cab for a high act is a crane move with an order to it. The
     * camera first lifts out to one side of the line; only when it is clear of
     * the train does the train draw ahead of it. Coming back it catches the
     * train up first, and slides in over the nose last. Each part takes
     * seconds, so nothing in the frame changes place faster than the eye follows.
     */
    const crane = (act, previous, t) => {
        const to = chaseAmount(act.params.height);
        const from = act.index ? chaseAmount(previous.params.height) : to;
        // Going up takes its time; coming back is a little brisker, to leave a break room for a scene.
        const p = (t - act.start) / Math.max(0.001, Math.min(to < from ? 7 : 10, (act.end - act.start) * 0.8));
        const height = (a, b) => act.index ? mix(previous.params.height, act.params.height, ease((p - a) / b))
            : act.params.height;
        if (to > from) return { out: mix(from, to, ease(p / 0.6)), lead: mix(from, to, ease((p - 0.25) / 0.75)),
            height: height(0, 0.6) };
        if (to < from) return { out: mix(from, to, ease((p - 0.4) / 0.6)), lead: mix(from, to, ease(p / 0.7)),
            height: height(0.3, 0.7) };
        return { out: to, lead: to, height: height(0, 0.5) };
    };
    /*
     * When nobody is singing for a while there is nothing to read, and the
     * camera can go somewhere else: back into the saloon of the leading car, or
     * out to the waterside to let the train run past. Scenes are planned once
     * from the song, so seeking lands in the same shot every time. They keep
     * clear of the high acts and end well before the next line.
     */
    const SCENE_KINDS = ['SALOON', 'TRACKSIDE'];
    const SCENE_BLEND = 3, SCENE_RAISE = 2.5;
    const planScenes = (timeline, options = {}) => {
        if (options.cameraCuts === false || options.reducedMotion) return [];
        const low = t => {
            const index = timeline.sample(t).actIndex, act = timeline.acts[index];
            const move = crane(act, timeline.acts[Math.max(0, index - 1)], t);
            return act.kind !== 'Terminus' && move.out === 0 && move.lead === 0;
        };
        const scenes = [];
        let cursor = 0;
        for (const busy of [...timeline.protectedIntervals, { start: timeline.duration, end: timeline.duration }]) {
            // The song may open inside the car; later scenes wait for the last screen to let go.
            let from = cursor ? cursor + 2.5 : 0;
            const until = busy.start - 5;
            while (until - from >= 7.5) {
                let start = from;
                while (start < until && !low(start)) start += 0.5;
                let end = start;
                while (end + 0.5 <= until && end - start < 14 && low(end + 0.5)) end += 0.5;
                // Watching the train go by needs longer than a look round the saloon.
                const wanted = start === 0 ? 'SALOON' : SCENE_KINDS[scenes.length % SCENE_KINDS.length];
                const kind = wanted === 'TRACKSIDE' && end - start < 10 ? 'SALOON' : wanted;
                if (end - start >= 7.5)
                    scenes.push({ id: scenes.length, kind, start, end, side: scenes.length % 2 ? 1 : -1 });
                from = Math.max(end, start + 0.5) + 8;
            }
            cursor = Math.max(cursor, busy.end);
        }
        return scenes;
    };
    // Where the saloon camera stands, measured back from the nose of the train.
    const SALOON = Object.freeze({ back: 9.1, travel: 2.4, lateral: 0.2, height: 2.66, sill: 2.35 });
    const TRACKSIDE = Object.freeze({ lateral: 6.5, height: 1.5 });
    const sceneAt = (track, t) => {
        const scenes = track.scenes || [];
        const scene = scenes[upperBound(scenes, t + SCENE_RAISE, 'start') - 1];
        if (!scene || t > scene.end + SCENE_RAISE) return null;
        const opening = scene.start === 0;
        const weight = (opening ? 1 : ease((t - scene.start) / SCENE_BLEND)) * (1 - ease((t - scene.end + SCENE_BLEND) / SCENE_BLEND));
        // The cab view is lifted to window height a little before and after, so
        // the way in and out of the car goes through the windscreen and not the floor.
        const raised = (opening ? 1 : ease((t - scene.start + SCENE_RAISE) / SCENE_RAISE))
            * (1 - ease((t - scene.end) / SCENE_RAISE));
        return { scene, weight, raised, progress: clamp((t - scene.start) / (scene.end - scene.start)) };
    };
    const rigFor = act => act.kind === 'Departure' ? 'RAIL'
        : ['Chorus', 'Open'].includes(act.kind) ? 'WIDE'
            : act.kind === 'Interlude' ? 'WINDOW'
                : act.kind === 'Verse' && act.index % 2 ? 'WINDOW' : 'CAB';
    const rigYaw = rig => rig === 'WINDOW' ? 0.7 : 0;
    const readingEnvelope = (timeline, t) => {
        const intervals = timeline.protectedIntervals;
        const index = upperBound(intervals, t, 'start') - 1;
        let result = 0;
        for (let i = Math.max(0, index); i <= Math.min(intervals.length - 1, index + 1); i++) {
            const interval = intervals[i];
            result = Math.max(result, smooth((t - interval.start + 0.3) / 0.3)
                * (1 - smooth((t - interval.end) / 0.3)));
        }
        return result;
    };
    const pose = (timeline, track, time, options = {}) => {
        const t = clamp(time, 0, timeline.duration);
        const state = timeline.sample(t);
        const motion = options.reducedMotion ? 0 : clamp(options.motionAmount ?? 1, 0, 2)
            * clamp(options.animationIntensity ?? 1, 0, 2);
        const distance = timeline.distanceAt(t, options.cameraSpeed ?? 1);
        const frame = track.at(distance);
        const act = timeline.acts[state.actIndex];
        const previous = timeline.acts[Math.max(0, state.actIndex - 1)];
        const cutsEnabled = motion && options.cameraCuts !== false;
        const cutIndex = cutsEnabled ? upperBound(timeline.cuts, t, 'time') - 1 : -1;
        const cut = cutIndex >= 0 ? timeline.cuts[cutIndex] : null;
        const currentCut = cut && cut.actIndex >= act.index ? cut : null;
        let rig = motion ? rigFor(act) : 'CAB';
        if (currentCut) rig = currentCut.rig || rigFor(timeline.acts[currentCut.actIndex]);
        const turn = track.turns?.[upperBound(track.turns, t, 'time') - 1];
        const yawBias = motion ? (turn
            ? mix(turn.from, turn.to, smooth((t - turn.time) / 3.5)) : track.initialYaw || 0) : 0;
        const reading = readingEnvelope(timeline, t);
        const seed = timeline.seedHash;
        const handheld = motion * (1 - reading * 0.55);
        const n = (frequency, offset) => noise(t * frequency, seed + offset);
        // Phrase-scale choreography, distinct from handheld vibration.
        // Zero velocity at the phrase edges avoids resetting motion on each word.
        const lineIndex = upperBound(timeline.lines, t, 'startTime') - 1;
        const line = timeline.lines[lineIndex];
        const vocalEnd = line ? (line.vocalEndTime ?? line.endTime) : 0;
        const lineDuration = line ? Math.max(0.1, vocalEnd - line.startTime) : 1;
        const lineProgress = line ? clamp((t - line.startTime) / lineDuration) : 0;
        // Rapid credits/short syllables must not compress a full camera move into milliseconds.
        const arch = Math.sin(Math.PI * lineProgress) ** 2 * smooth((lineDuration - 1.2) / 2);
        const directionSign = lineIndex % 2 ? -1 : 1;
        const strength = Math.min(1.5, motion);
        const openness = state.openness;
        const lateralTravel = directionSign * arch * (0.35 + openness * 0.65) * strength;
        const lift = arch * (0.12 + openness * 0.5) * strength;
        const push = arch * openness * 0.6 * strength;
        const move = crane(act, previous, t);
        const staged = motion ? sceneAt(track, t) : null;
        const inside = staged?.scene.kind === 'SALOON' ? staged : null;
        const beside = staged?.scene.kind === 'TRACKSIDE' ? staged : null;
        // Out to the waterside, the train past, the train caught up, back in: in that order.
        const aside = beside ? ease(beside.progress / 0.25) * (1 - ease((beside.progress - 0.8) / 0.2)) : 0;
        const passed = beside ? ease((beside.progress - 0.1) / 0.4) * (1 - ease((beside.progress - 0.55) / 0.3)) : 0;
        if (inside) move.height = mix(move.height, Math.max(move.height, SALOON.sill), inside.raised);
        if (beside) move.height = mix(move.height, TRACKSIDE.height, aside);
        const position = {
            x: frame.position.x + frame.right.x * (-0.25 + n(0.8, 1) * 0.025 * handheld),
            y: (motion ? move.height : 2.2) + Math.sin(t * Math.PI * 0.4) * 0.01 * handheld
                + n(1.3, 2) * 0.018 * handheld + timeline.rhythmAt(t).impulse * 0.012 * handheld,
            z: frame.position.z + frame.right.z * -0.25
        };
        position.x += frame.right.x * lateralTravel + frame.forward.x * push;
        position.z += frame.right.z * lateralTravel + frame.forward.z * push;
        position.y += lift;
        // Low acts are seen from the cab. When the camera rises it also leaves the
        // train: it swings out to one side and lets the train run ahead, so the
        // high acts look down on lit carriages crossing the water.
        const chase = motion ? Math.max(move.out, aside) : 0;
        const swing = motion ? CHASE_LATERAL * move.out + TRACKSIDE.lateral * aside : 0;
        position.x += frame.right.x * swing;
        position.z += frame.right.z * swing;
        let yaw = frame.yaw + yawBias + n(0.55, 3) * 0.003 * handheld
            + directionSign * arch * openness * 0.012 * strength - 0.075 * (motion ? move.out : 0);
        let pitch = mix(-0.025, -0.12, state.openness);
        const finale = state.act === 'Terminus' && motion && !timeline.isSinging(t)
            ? smooth((t - act.start) / Math.max(1, act.end - act.start)) : 0;
        // A stationary roadside screen owns the gaze, never the train position.
        // Derive the blend analytically so seeking midway through a handoff is exact.
        const encounters = track.encounters || [];
        const encounterIndex = upperBound(encounters, t, 'start') - 1;
        const encounter = encounters[encounterIndex];
        const upcoming = encounters[encounterIndex + 1];
        const blendAngle = (a, b, weight) => a
            + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * weight;
        let fov = motion ? state.fov - arch * (1.2 + openness * 1.8) * strength : 48;
        const halfFrame = Math.atan(Math.tan(fov * Math.PI / 360) * Math.max(0.35, options.aspect || 1.6)) * 0.84;
        // A screen is read from its own side of the frame, with the line ahead
        // still in view: the camera turns only as far as it takes to hold the
        // whole screen inside the picture. Going from one screen to the next is
        // then a short pan across the track instead of a swing from side to side.
        const aim = item => {
            const dx = item.position.x - position.x;
            const dz = item.position.z - position.z;
            const reach = Math.hypot(dx, dz);
            const pitch = Math.atan2(item.position.y - position.y, reach);
            const full = Math.atan2(dx, -dz);
            if (!item.width) return { yaw: full, pitch };
            const off = Math.atan2(Math.sin(full - frame.yaw), Math.cos(full - frame.yaw));
            const needed = Math.abs(off) + Math.atan(item.width * 0.5 / reach) - halfFrame;
            const turn = Math.min(Math.abs(off), Math.max(needed, Math.abs(off) * 0.6));
            return { yaw: frame.yaw + Math.sign(off) * turn, pitch };
        };
        let encounterId = null;
        const directHandoff = encounter && upcoming && t >= encounter.end
            && upcoming.start - encounter.end > 0 && upcoming.start - encounter.end <= 7;
        if (directHandoff) {
            const a = aim(encounter), b = aim(upcoming);
            const weight = smooth((t - encounter.end) / (upcoming.start - encounter.end));
            yaw = blendAngle(a.yaw, b.yaw, weight);
            pitch = mix(a.pitch, b.pitch, weight);
            encounterId = weight < 0.5 ? encounter.id : upcoming.id;
            rig = 'WINDOW';
        }
        if (encounter && !directHandoff) {
            const release = Math.min(upcoming ? Math.min(4, Math.max(0.1, upcoming.start - encounter.end)) : 4,
                Math.max(0.8, encounter.skyStart - encounter.end));
            const weight = 1 - smooth((t - encounter.end) / release);
            if (weight > 0) {
                const target = aim(encounter);
                yaw = blendAngle(yaw, target.yaw, weight);
                pitch = mix(pitch, target.pitch, weight);
                encounterId = encounter.id;
                rig = 'WINDOW';
            }
        }
        if (upcoming && !directHandoff) {
            const lead = Math.min(5, Math.max(0.1, upcoming.start - (encounter?.end ?? 0)));
            const weight = smooth((t - upcoming.start + lead) / lead);
            if (weight > 0) {
                const target = aim(upcoming);
                yaw = blendAngle(yaw, target.yaw, weight);
                pitch = mix(pitch, target.pitch, weight);
                encounterId = upcoming.id;
            }
        }
        let eventFocus = null;
        const events = track.events || [];
        const event = events[upperBound(events, t, 'start') - 1];
        if (motion && options.journeyEvents !== false && event?.kind === 'whale'
            && t < event.end && !timeline.isSinging(t)) {
            const performance = global.MusicStageDioramaEvents.sample(event, t);
            const age = performance.age;
            const weight = smooth(age / 2) * (1 - smooth((age - 8.2) / 2.8));
            const target = aim({ position: {
                x: performance.body.x, y: Math.max(0.8, performance.body.y), z: performance.body.z
            } });
            yaw = blendAngle(yaw, target.yaw, weight);
            pitch = mix(pitch, target.pitch, weight);
            // Reserve room for head and tail, particularly in portrait windows.
            const aspect = Math.max(0.35, options.aspect || 1.6);
            const distanceToBody = Math.hypot(performance.body.x - position.x, performance.body.z - position.z);
            const fit = 2 * Math.atan(15 / Math.max(1, distanceToBody * Math.min(1, aspect))) * 180 / Math.PI;
            fov = mix(fov, Math.max(fov, Math.min(80, fit)), weight);
            eventFocus = { id: event.id, weight };
        }
        // Apply after roadside gaze release so the last sign cannot cancel the skyward finale.
        // The moon uses this same fixed celestial offset in the world renderer.
        yaw = blendAngle(yaw, Math.atan2(-210, 420), finale);
        pitch = mix(pitch, Math.atan2(300 - position.y, Math.hypot(210, 420)), finale);
        pitch += n(0.7, 4) * 0.0025 * handheld * (1 - finale);
        let roll = motion ? n(0.45, 5) * 0.002 * handheld + directionSign * arch * openness * 0.006 * strength : 0;
        if (aside > 0) {
            // From the waterside the camera looks back in over the line, level
            // with the windows, and the train comes through the picture.
            yaw = blendAngle(yaw, frame.yaw - 0.34, aside);
            pitch = mix(pitch, 0.015, aside);
            fov = mix(fov, 52, aside);
        }
        if (inside && inside.weight > 0) {
            // Standing in the aisle a few windows back from the cab, drifting
            // forward, looking along one row of windows at what goes by.
            const w = inside.weight, side = inside.scene.side;
            const along = distance - SALOON.back + SALOON.travel * inside.progress;
            const car = track.at(along);
            const offset = -side * SALOON.lateral + Math.sin(t * 0.9) * 0.015;
            position.x = mix(position.x, car.position.x + car.right.x * offset, w);
            position.z = mix(position.z, car.position.z + car.right.z * offset, w);
            position.y = mix(position.y, SALOON.height + Math.sin(t * 1.7) * 0.006, w);
            yaw = blendAngle(yaw, car.yaw + side * 0.42 + Math.sin(t * 0.23) * 0.05, w);
            pitch = mix(pitch, -0.05, w);
            fov = mix(fov, 60, w);
            roll = mix(roll, Math.sin(t * 1.1) * 0.004, w);
        }
        const cp = Math.cos(pitch);
        const direction = { x: Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
        return {
            position, direction, yaw, pitch,
            roll, fov, eventFocus, finale,
            // How far the saloon has to be there to be seen or passed through.
            saloon: inside ? inside.raised : 0,
            scene: staged && staged.weight > 0 ? { id: staged.scene.id, kind: staged.scene.kind, weight: staged.weight } : null,
            shot: openness > 0.6 ? 'rising-traverse' : 'window-tracking',
            rig: !motion ? 'CAB' : staged && staged.weight > 0.5 ? staged.scene.kind : rig,
            encounterId, reading, distance, state, chase,
            // Where the front of the train is along the line.
            trainFront: distance + mix(-0.4, CHASE_LEAD, motion ? Math.max(move.lead, passed) : 0),
            look: { x: position.x + direction.x * 30, y: position.y + direction.y * 30,
                z: position.z + direction.z * 30 }
        };
    };
    global.MusicStageDioramaCamera = Object.freeze({ createTrack, pose, noise, readingEnvelope, planScenes });
})(window);