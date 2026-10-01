; Shows the app's name (OverlookDB) in the installer wizard. productName has to stay JDB, since it
; decides the install folder, the userData folder holding the password key, and the app id, so the
; wizard's name is set here instead, after electron-builder's own from productName. Setting it again
; is warning 6029, which electron-builder treats as an error, so that one warning is allowed here only.
!macro customHeader
  !pragma warning push
  !pragma warning disable 6029
  Name "OverlookDB"
  BrandingText "OverlookDB ${VERSION}"
  !pragma warning pop
!macroend
