function gtag(...args) {
  if (typeof window !== 'undefined' && window.gtag) window.gtag(...args)
}

export const track = {
  compileClicked:       ()            => gtag('event', 'compile_clicked'),
  compileSuccess:       ()            => gtag('event', 'compile_success'),
  compileError:         (message)     => gtag('event', 'compile_error', { error_message: message }),
  gcodeDownloaded:      ()            => gtag('event', 'gcode_downloaded'),
  gcodeLineClicked:     ()            => gtag('event', 'gcode_line_clicked'),
  postProcessorChanged: (processor)   => gtag('event', 'post_processor_changed', { post_processor: processor }),
  previewModeChanged:   (mode)        => gtag('event', 'preview_mode_changed', { mode }),
  timelinePlayed:       ()            => gtag('event', 'timeline_played'),
  timelineSpeedChanged: (speed)       => gtag('event', 'timeline_speed_changed', { speed }),
  rightPanelTabSwitched:(tab)         => gtag('event', 'right_panel_tab_switched', { tab }),
}
