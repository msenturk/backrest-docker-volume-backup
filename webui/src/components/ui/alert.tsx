import { Alert as ChakraAlert } from "@chakra-ui/react"
import * as React from "react"

export interface AlertProps extends ChakraAlert.RootProps {
  title?: string
  icon?: React.ReactElement
}

export const Alert = React.forwardRef<HTMLDivElement, AlertProps>(
  function Alert(props, ref) {
    const { title, children, icon, ...rest } = props
    return (
      <ChakraAlert.Root ref={ref} {...rest}>
        <ChakraAlert.Indicator>{icon}</ChakraAlert.Indicator>
        <ChakraAlert.Content>
          {title && <ChakraAlert.Title>{title}</ChakraAlert.Title>}
          <ChakraAlert.Description>{children}</ChakraAlert.Description>
        </ChakraAlert.Content>
      </ChakraAlert.Root>
    )
  },
)
