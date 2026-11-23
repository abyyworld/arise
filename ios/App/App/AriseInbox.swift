import CoreLocation
import Foundation
import UIKit

// What happens while the web app isn't running (a Shortcuts automation ran "Log to Arise", the
// Player arrived somewhere or left) goes into a small file, one JSON object per line. The web app
// takes it when it opens, adds it to the life log, then clears it (src/life/sense.ts).
//
// If you change this file in a way the web app relies on, raise OWN_NATIVE in vite.config.ts, so
// an older Arise.ipa isn't sent web code it can't run.
enum AriseInbox {
    private static let lock = NSLock()

    private static var folder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("Arise", isDirectory: true)
    }
    private static var inbox: URL { folder.appendingPathComponent("inbox.jsonl") }
    // Taken by the web app but not cleared yet: given again next time, so nothing is lost if the
    // app closes halfway.
    private static var taking: URL { folder.appendingPathComponent("inbox-taking.jsonl") }

    static func append(_ entry: [String: Any]) throws {
        var line = try JSONSerialization.data(withJSONObject: entry, options: [])
        line.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        let files = FileManager.default
        try files.createDirectory(at: folder, withIntermediateDirectories: true)
        if files.fileExists(atPath: inbox.path) {
            let handle = try FileHandle(forWritingTo: inbox)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: line)
        } else {
            try line.write(to: inbox, options: .atomic)
        }
    }

    // Everything waiting, as text.
    static func take() throws -> String {
        lock.lock()
        defer { lock.unlock() }
        let files = FileManager.default
        if files.fileExists(atPath: inbox.path) {
            if files.fileExists(atPath: taking.path) {
                let more = try Data(contentsOf: inbox)
                let handle = try FileHandle(forWritingTo: taking)
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: more)
                try files.removeItem(at: inbox)
            } else {
                try files.moveItem(at: inbox, to: taking)
            }
        }
        guard files.fileExists(atPath: taking.path) else { return "" }
        return try String(decoding: Data(contentsOf: taking), as: UTF8.self)
    }

    // The web app has kept what take() gave it.
    static func clear() {
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.removeItem(at: taking)
    }
}

// Places: iOS tells the app when the Player arrives somewhere and when they leave (visit
// monitoring). It does this even while Arise is closed, by starting it in the background for a
// moment, so this is set up when the app starts (AppDelegate). Only while Places is on in Arise.
//
// Location on a timer (src/life/location-sense.ts): iOS can't wake an app on a timer, so with
// "Always" Arise keeps low-power location updates on and keeps one point per interval. iOS pauses
// the updates while the Player sits still, and big moves (significant location changes) start them
// again, so points are sparse while nothing changes. Each point goes through the places never to
// note and the rounding before it's kept, then waits in the inbox with the visits.
final class ArisePlaces: NSObject, CLLocationManagerDelegate {
    static let shared = ArisePlaces()
    private static let onKey = "arise.places.on"
    private static let modeKey = "arise.location.mode"
    private static let everyKey = "arise.location.every"
    private static let exactKey = "arise.location.exact"
    private static let neverKey = "arise.location.never"
    private static let lastKey = "arise.location.last"
    private static let pausedKey = "arise.pausedUntil"
    private let manager = CLLocationManager()
    private var updating = false
    private var updatesPaused = false
    private var waiting: [(CLLocation?) -> Void] = []

    private override init() {
        super.init()
        manager.delegate = self
    }

    var isOn: Bool {
        get { UserDefaults.standard.bool(forKey: ArisePlaces.onKey) }
        set { UserDefaults.standard.set(newValue, forKey: ArisePlaces.onKey) }
    }

    // "places" (visits only) or "interval" (visits, and a point every `every` minutes).
    var mode: String {
        get { UserDefaults.standard.string(forKey: ArisePlaces.modeKey) ?? "places" }
        set { UserDefaults.standard.set(newValue, forKey: ArisePlaces.modeKey) }
    }

    var every: Int {
        get {
            let v = UserDefaults.standard.integer(forKey: ArisePlaces.everyKey)
            return v >= 1 && v <= 720 ? v : 30
        }
        set { UserDefaults.standard.set(min(720, max(1, newValue)), forKey: ArisePlaces.everyKey) }
    }

    var exact: Bool {
        get { UserDefaults.standard.object(forKey: ArisePlaces.exactKey) as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: ArisePlaces.exactKey) }
    }

    // Places never to note: [latitude, longitude, radius in meters] each.
    var never: [[Double]] {
        get { (UserDefaults.standard.array(forKey: ArisePlaces.neverKey) as? [[Double]]) ?? [] }
        set { UserDefaults.standard.set(newValue, forKey: ArisePlaces.neverKey) }
    }

    // Pause everything (src/life/pause.ts): nothing is noted until this time (ms since 1970).
    var pausedUntil: Double {
        get { UserDefaults.standard.double(forKey: ArisePlaces.pausedKey) }
        set { UserDefaults.standard.set(newValue, forKey: ArisePlaces.pausedKey) }
    }

    private var paused: Bool { pausedUntil > Date().timeIntervalSince1970 * 1000 }

    var status: String {
        switch manager.authorizationStatus {
        case .authorizedAlways: return "always"
        case .authorizedWhenInUse: return "whenInUse"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    // Starts or stops watching, to match the switch and what the Player allowed.
    func update() {
        let always = manager.authorizationStatus == .authorizedAlways
        let allowed = always || manager.authorizationStatus == .authorizedWhenInUse
        if isOn && allowed {
            manager.startMonitoringVisits()
        } else {
            manager.stopMonitoringVisits()
        }
        if isOn && allowed && mode == "interval" {
            manager.activityType = .other
            manager.desiredAccuracy = exact ? kCLLocationAccuracyHundredMeters : kCLLocationAccuracyKilometer
            manager.distanceFilter = exact ? 50 : 500
            manager.pausesLocationUpdatesAutomatically = true
            if always {
                manager.allowsBackgroundLocationUpdates = true
                manager.showsBackgroundLocationIndicator = false
                manager.startMonitoringSignificantLocationChanges()
            }
            manager.startUpdatingLocation()
            updating = true
            updatesPaused = false
        } else if updating {
            manager.stopUpdatingLocation()
            manager.stopMonitoringSignificantLocationChanges()
            manager.allowsBackgroundLocationUpdates = false
            updating = false
        }
    }

    // Asks for While Using first, then for Always. iOS shows each question at most once.
    func ask(_ done: @escaping () -> Void) {
        switch manager.authorizationStatus {
        case .notDetermined:
            AriseAsk.afterPrompt({ self.manager.requestWhenInUseAuthorization() }, then: {
                // The answer can reach the location manager a moment after the app is back.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    if self.manager.authorizationStatus == .authorizedWhenInUse {
                        AriseAsk.afterPrompt({ self.manager.requestAlwaysAuthorization() }, then: done)
                    } else {
                        done()
                    }
                }
            })
        case .authorizedWhenInUse:
            AriseAsk.afterPrompt({ self.manager.requestAlwaysAuthorization() }, then: done)
        default:
            done()
        }
    }

    // Where the iPhone is now, once (to add a place never to note). Main thread only.
    func now(_ done: @escaping (CLLocation?) -> Void) {
        let allowed = manager.authorizationStatus == .authorizedAlways || manager.authorizationStatus == .authorizedWhenInUse
        guard allowed else {
            done(nil)
            return
        }
        if let l = manager.location, Date().timeIntervalSince(l.timestamp) < 60 {
            done(l)
            return
        }
        waiting.append(done)
        if waiting.count == 1 {
            manager.requestLocation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
            self.answer(nil)
        }
    }

    private func answer(_ l: CLLocation?) {
        let list = waiting
        waiting = []
        for done in list {
            done(l)
        }
    }

    private func inNever(_ c: CLLocationCoordinate2D) -> Bool {
        let here = CLLocation(latitude: c.latitude, longitude: c.longitude)
        for n in never where n.count >= 3 {
            if here.distance(from: CLLocation(latitude: n[0], longitude: n[1])) <= n[2] {
                return true
            }
        }
        return false
    }

    private static func fix(_ v: Double) -> Double {
        return (v * 100_000).rounded() / 100_000
    }

    // To about 1 km, the same grid as the web app (src/life/location.ts, roundSpot).
    static func rounded(_ lat: Double, _ lon: Double) -> (Double, Double) {
        let step = 0.01
        let rlat = (lat / step).rounded() * step
        let wide = min(1, step / max(0.01, cos(rlat * .pi / 180)))
        return (fix(rlat), fix(max(-180, min(180, (lon / wide).rounded() * wide))))
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        update()
    }

    func locationManagerDidPauseLocationUpdates(_ manager: CLLocationManager) {
        updatesPaused = true
    }

    func locationManagerDidResumeLocationUpdates(_ manager: CLLocationManager) {
        updatesPaused = false
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        if !waiting.isEmpty {
            answer(locations.last)
        }
        guard isOn, mode == "interval" else { return }
        // A big move woke Arise while iOS had paused the updates: on again.
        if updatesPaused {
            updatesPaused = false
            manager.startUpdatingLocation()
        }
        guard !paused else { return }
        let gap = Double(every) * 60 * 0.8
        for l in locations {
            if l.horizontalAccuracy < 0 || inNever(l.coordinate) { continue }
            let at = l.timestamp.timeIntervalSince1970
            let last = UserDefaults.standard.double(forKey: ArisePlaces.lastKey)
            if last > 0 && at >= last && at - last < gap { continue }
            UserDefaults.standard.set(at, forKey: ArisePlaces.lastKey)
            var entry: [String: Any] = ["type": "point", "id": UUID().uuidString, "at": at * 1000]
            if exact {
                entry["lat"] = l.coordinate.latitude
                entry["lon"] = l.coordinate.longitude
                entry["acc"] = l.horizontalAccuracy
            } else {
                let (lat, lon) = ArisePlaces.rounded(l.coordinate.latitude, l.coordinate.longitude)
                entry["lat"] = lat
                entry["lon"] = lon
                entry["acc"] = 1000
            }
            try? AriseInbox.append(entry)
        }
    }

    func locationManager(_ manager: CLLocationManager, didVisit visit: CLVisit) {
        guard isOn, !paused, !inNever(visit.coordinate) else { return }
        var lat = visit.coordinate.latitude
        var lon = visit.coordinate.longitude
        if !exact {
            (lat, lon) = ArisePlaces.rounded(lat, lon)
        }
        var entry: [String: Any] = [
            "type": "visit",
            "id": UUID().uuidString,
            "lat": lat,
            "lon": lon,
            "acc": exact ? visit.horizontalAccuracy : 1000,
        ]
        // iOS uses these two for "not known": arrived before watching began, or not left yet.
        if visit.arrivalDate != Date.distantPast {
            entry["arrive"] = visit.arrivalDate.timeIntervalSince1970 * 1000
        }
        if visit.departureDate != Date.distantFuture {
            entry["depart"] = visit.departureDate.timeIntervalSince1970 * 1000
        }
        try? AriseInbox.append(entry)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        if !waiting.isEmpty {
            answer(nil)
        }
    }
}

// Runs `ask`, which may show one of iOS's permission questions, then `then` once the Player has
// answered: the question makes the app inactive until it's answered. When iOS shows nothing
// (it already asked once), `then` runs soon after. Main thread only.
final class AriseAsk {
    private var shown = false
    private var finished = false
    private var observers: [NSObjectProtocol] = []
    private let then: () -> Void

    private init(then: @escaping () -> Void) {
        self.then = then
    }

    static func afterPrompt(_ ask: () -> Void, then: @escaping () -> Void) {
        let watch = AriseAsk(then: then)
        let center = NotificationCenter.default
        watch.observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            watch.shown = true
        })
        watch.observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            if watch.shown { watch.finish() }
        })
        ask()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            if !watch.shown { watch.finish() }
        }
    }

    private func finish() {
        if finished { return }
        finished = true
        for observer in observers {
            NotificationCenter.default.removeObserver(observer)
        }
        observers = []
        then()
    }
}
