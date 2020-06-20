import {
    ACTION_MODAL_REQUEST,
    ACTION_MODAL_SUBMISSION, ACTION_TICKET_CHANGED,
    FlowAction,
    ServiceFlow
} from "./index";
import {findProperty, findNestedProperty, getNestedVal} from "@nexus-switchboard/nexus-extend";
import moduleInstance, {logger} from "../../index";
import ServiceRequest, {IRequestParams} from "../request";
import {SlackMessageId} from "../slack/slackMessageId";
import RequestModal from "../slack/requestModal";
import {getMessageFromSlackErr} from "../util";
import {ChannelAssignments, SlackThread} from "../slack/slackThread";
import {FlowOrchestrator} from "./orchestrator";


/**
 *
 * INTAKE FLOW
 *
 * Handles actions that involve receiving details about the request.
 */
export class IntakeFlow extends ServiceFlow {

    protected _getFlowActions(_payload: any, _additionalData: any): FlowAction[] {
        return [ACTION_MODAL_REQUEST, ACTION_MODAL_SUBMISSION, ACTION_TICKET_CHANGED]
    }

    protected async _handleActionSlowResponse(action: FlowAction, payload: any, additionalData: any): Promise<boolean> {
        if (action === ACTION_MODAL_REQUEST) {
            return await IntakeFlow.beginRequestCreation(payload, additionalData ? additionalData.defaultText : undefined);
        } else if (action === ACTION_MODAL_SUBMISSION) {
            return await IntakeFlow.finishRequestCreation(payload);
        } else if (action === ACTION_TICKET_CHANGED) {
            return FlowOrchestrator.buildRequestObFromJiraEvent(additionalData, payload)
                .then((request: ServiceRequest) => {
                    if (action === ACTION_TICKET_CHANGED) {
                        request.updateSlackThread();
                        return true;
                    } else {
                        return false;
                    }
                });
        }
        else {
            return false;
        }

    }

    protected _handleActionImmediateResponse(_action: FlowAction, _payload: any, _additionalData: any): boolean {
        return true;
    }


    /**
     * This static method should be used  when there is no existing thread for the request.  This will
     * do the work of posting the top level message and displaying the modal that collects input from the user.
     *
     * @param payload
     * @param defaultText
     */
    public static async beginRequestCreation(payload: any, defaultText?: string): Promise<boolean> {

        if (!defaultText) {
            defaultText = moduleInstance.getSlack().extractTextFromPayload(payload).join("");
        }

        const modConfig = moduleInstance.getActiveModuleConfig();
        const channel = modConfig.SLACK_PRIMARY_CHANNEL;
        const triggerId = getNestedVal(payload, 'trigger_id');

        if (channel) {
            const slackUserId = findNestedProperty(payload, "user", "id");
            await IntakeFlow.showCreateModal(triggerId, {
                slackUserId,
                title: defaultText,
                channelId: channel
            });
            return true;
        } else {
            logger("Unable to show the create modal because the originating channel could not be found");
            return false;
        }
    }


    /**
     * Factory method to create a new Request object.  This should be called when you expect to have the ticket
     * already setup as a thread in the Slack channel.  This will attach to it and return the new ServiceRequest object
     * filled in with all the right values.
     *          occurred.  This could be the primary channel or another channel in which infrabot was invited.
     * @param payload
     */
    public static async finishRequestCreation(payload: any): Promise<boolean> {

        try {
            const channelId = findProperty(payload, "private_metadata");
            if (channelId) {
                const slackUserId = findNestedProperty(payload, "user", "id");
                const values = {
                    summary: getNestedVal(payload, "view.state.values.title_input.title.value"),
                    description: getNestedVal(payload, "view.state.values.description_input.description.value"),
                    priority: getNestedVal(payload, "view.state.values.priority_input.priority.selected_option.value"),
                    category: getNestedVal(payload, "view.state.values.category_input.category.selected_option.value")
                };

                const slack = moduleInstance.getSlack();

                // Determine which channel should be the notification channel and which should be the
                //   conversation channel.
                const channels = IntakeFlow.identifyChannelAssignments(channelId);

                // Now post a message in the conversation channel - this message will serve as the root of the request
                //  in slack and all further conversation will happen here.
                const message = await slack.apiAsBot.chat.postMessage({
                        channel: channels.conversationChannelId,
                        text: `:gear: Creating a ticket for <@${slackUserId}> `
                    }
                );

                const messageTs = findProperty(message, "ts");

                // Now we have all the info we need to create a service request object.
                const request = new ServiceRequest(new SlackMessageId(channels.conversationChannelId, messageTs), channels.notificationChannelId, slackUserId);

                // And use the service request object to create the ticket.
                return await request.create({
                    slackUserId,
                    title: values.summary,
                    description: values.description,
                    priority: values.priority,
                    components: [values.category]
                });
            } else {
                logger("Unable to show the create modal because the originating channel could not be found");
                return false;
            }

        } catch (e) {
            logger("There was a problem finishing the infra request submission: " + e.toString());
            return false;
        }
    }

    /**
     * This will show the infra request modal and use the message that triggered it to prepopulate it.
     * @param triggerId
     * @param requestParams
     */
    protected static async showCreateModal(triggerId: string, requestParams: IRequestParams): Promise<boolean> {

        try {

            // Note: It's okay if modal config is not set - there are defaults for this.
            const modalConfig = ServiceRequest.config.SUBMIT_MODAL_CONFIG;

            const modal = new RequestModal(requestParams, modalConfig, requestParams.channelId);
            return modal.show(triggerId);

        } catch (e) {
            logger("Exception thrown: Trying to show the create modal: " + getMessageFromSlackErr(e));
            return false;
        }
    }


    /**
     * Given a starting channel (where a user initiated a request), this will return what should be
     * the primary channel (where future request conversations go) and which should be considered
     * the "notification" channel.
     * @param startingChannelId
     */
    protected static identifyChannelAssignments(startingChannelId: string): ChannelAssignments {
        return SlackThread.determineConversationChannel(startingChannelId,
            moduleInstance.getActiveModuleConfig().SLACK_PRIMARY_CHANNEL,
            ServiceRequest.config.SLACK_CONVERSATION_RESTRICTION);
    }

}
